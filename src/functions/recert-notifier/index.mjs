/**
 * Recert Notifier Lambda - sends SES emails for owner-driven recertification.
 * One HTML email per owner with all their owned resources grouped by identity source.
 * @module functions/recert-notifier
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { QueryCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { toISOString, toIST, toEpoch } from '../../shared/time-utils.mjs';
import {
  KEY_PREFIXES, SK_PREFIXES, ENTITY_TYPES,
} from '../../shared/constants.mjs';

const sesClient = new SESClient({});
const SENDER_EMAIL = process.env.SES_SENDER_EMAIL || 'noreply@example.com';
const UI_DOMAIN = process.env.UI_DOMAIN || 'https://localhost:5173';

// Handler 

export const handler = async (event) => {
  try {
    const action = event.action || event.detail?.action;
    const cycleId = event.cycleId || event.detail?.cycleId;

    if (!action || !cycleId) {
      console.log(JSON.stringify({ action: 'NOTIFIER_NO_OP', event, timestamp: toISOString(new Date()) }));
      return;
    }

    const routes = {
      INITIAL: () => sendInitialNotifications(cycleId),
      REMINDER_7D: () => sendReminders(cycleId, 'REMINDER'),
      REMINDER_12D: () => sendReminders(cycleId, 'URGENT'),
      ESCALATION_14D: () => sendEscalation(cycleId),
      REVOCATION_CONFIRMATION: () => sendRevocationConfirmation(event),
      TRANSFER_NOTIFICATION: () => sendTransferNotification(event),
    };

    const routeFn = routes[action];
    if (routeFn) return await routeFn();

    console.log(JSON.stringify({ action: 'UNKNOWN_ACTION', requestedAction: action, timestamp: toISOString(new Date()) }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'RECERT_NOTIFIER_ERROR',
      message: error.message,
      function: 'recert-notifier',
      timestamp: toISOString(new Date()),
    }));
  }
};

// Initial Notification 

const sendInitialNotifications = async (cycleId) => {
  const cycle = await getCycleSummary(cycleId);
  if (!cycle) return;

  const ownerItems = await getReviewItemsByCycle(cycleId);
  const ownerMap = groupByOwner(ownerItems);

  for (const [ownerEmail, items] of Object.entries(ownerMap)) {
    if (!ownerEmail) continue;

    const byService = groupItemsByService(items);

    const html = buildInitialEmailHtml({
      ownerEmail,
      cycleId,
      reviewCount: items.length,
      byService,
      deadline: toIST(new Date(cycle.deadline)),
      reviewUrl: `${UI_DOMAIN}/recert/${cycleId}`,
      items,
    });

    await sendEmail({
      to: ownerEmail,
      subject: `[ACTION REQUIRED] ${cycleId} AWS Resource Recertification - ${items.length} resources to review`,
      html,
      cycleId,
      ownerEmail,
      notificationType: 'INITIAL',
    });
  }
};

// Reminders 

const sendReminders = async (cycleId, urgency) => {
  const ownerItems = await getReviewItemsByCycle(cycleId);
  const ownerMap = groupByOwner(ownerItems);

  for (const [ownerEmail, items] of Object.entries(ownerMap)) {
    const pending = items.filter((i) => i.status === 'PENDING');
    if (pending.length === 0 || !ownerEmail) continue;

    const isUrgent = urgency === 'URGENT';
    const subject = isUrgent
      ? `[URGENT - 2 DAYS REMAINING] ${cycleId} Access Recertification`
      : `[REMINDER] ${cycleId} Access Recertification - ${pending.length} reviews pending`;

    const html = buildReminderEmailHtml({
      ownerEmail,
      cycleId,
      pendingCount: pending.length,
      isUrgent,
      reviewUrl: `${UI_DOMAIN}/recert/${cycleId}`,
    });

    await sendEmail({
      to: ownerEmail,
      subject,
      html,
      cycleId,
      ownerEmail,
      notificationType: isUrgent ? 'REMINDER_12D' : 'REMINDER_7D',
    });
  }
};

// Escalation 

const sendEscalation = async (cycleId) => {
  const ownerItems = await getReviewItemsByCycle(cycleId);
  const ownerMap = groupByOwner(ownerItems);
  const itGovernanceEmail = process.env.IT_GOVERNANCE_EMAIL || SENDER_EMAIL;

  for (const [ownerEmail, items] of Object.entries(ownerMap)) {
    const pending = items.filter((i) => i.status === 'PENDING');
    if (pending.length === 0) continue;

    const html = buildEscalationEmailHtml({
      ownerEmail,
      cycleId,
      pendingCount: pending.length,
      reviewUrl: `${UI_DOMAIN}/recert/${cycleId}`,
    });

    await sendEmail({
      to: itGovernanceEmail,
      subject: `[ESCALATION] ${cycleId} Access Recertification - ${ownerEmail} has not completed review`,
      html,
      cycleId,
      ownerEmail,
      notificationType: 'ESCALATION_14D',
    });
  }
};

// Revocation Confirmation 

const sendRevocationConfirmation = async (event) => {
  const { cycleId, resourceArn, resourceName, ownerEmail, userId, userName } = event;
  const targetEmail = ownerEmail;
  if (!targetEmail) return;

  const displayName = resourceName || resourceArn || userName || userId || 'Unknown resource';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#d32f2f;">Resource Access Revocation - Ticket Created</h2>
      <p>A revocation ticket has been created for resource <strong>${displayName}</strong> as per your ${cycleId} recertification decision.</p>
      <p>An IT administrator will review and action this ticket. You will be notified when access changes are applied.</p>
      <p style="font-size:12px;color:#666;">Resource ARN: ${resourceArn || 'N/A'}</p>
      <p style="color:#666;font-size:12px;">Identity Governance System</p>
    </div>
  `;

  await sendEmail({
    to: targetEmail,
    subject: `Revocation Ticket Created - ${displayName} (${cycleId})`,
    html,
    cycleId,
    ownerEmail: targetEmail,
    notificationType: 'REVOCATION_CONFIRMATION',
  });
};

// Transfer Notification 

const sendTransferNotification = async (event) => {
  const { cycleId, newOwnerEmail, pendingCount, oldOwnerEmail } = event;
  if (!newOwnerEmail) return;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#1976d2;">Access Reviews Transferred to You</h2>
      <p>You have been assigned <strong>${pendingCount}</strong> pending access reviews previously owned by <strong>${oldOwnerEmail}</strong>.</p>
      <p><a href="${UI_DOMAIN}/recert/${cycleId}" style="background:#1976d2;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;">Review Now</a></p>
      <p style="color:#666;font-size:12px;">Identity Governance System</p>
    </div>
  `;

  await sendEmail({
    to: newOwnerEmail,
    subject: `[ACTION REQUIRED] ${pendingCount} Access Reviews Transferred - ${cycleId}`,
    html,
    cycleId,
    ownerEmail: newOwnerEmail,
    notificationType: 'TRANSFER_NOTIFICATION',
  });
};

// Email Builders 

const buildInitialEmailHtml = ({ ownerEmail, cycleId, reviewCount, byService, deadline, reviewUrl, items }) => {
  const serviceBreakdown = Object.entries(byService)
    .map(([svc, svcItems]) => `${svcItems.length} ${svc.toUpperCase()}`)
    .join(', ');

  const tableRows = buildResourceTableRows(byService);

  return `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;">
      <h2 style="color:#1976d2;">${cycleId} AWS Resource Recertification</h2>
      <p>Hi ${ownerEmail},</p>
      <p>The ${cycleId} quarterly resource recertification is now open. You own <strong>${reviewCount}</strong> AWS resources that require your review (${serviceBreakdown}).</p>
      <p><strong>DEADLINE:</strong> ${deadline} IST</p>
      <p><a href="${reviewUrl}" style="background:#1976d2;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Review Resources</a></p>
      ${tableRows}
      <p style="color:#666;font-size:12px;margin-top:24px;">Identity Governance System</p>
    </div>
  `;
};

const groupItemsByService = (items) => {
  const grouped = {};
  for (const item of items) {
    const svc = item.service || item.resourceType?.split(':')[0] || 'unknown';
    if (!grouped[svc]) grouped[svc] = [];
    grouped[svc].push(item);
  }
  return grouped;
};

const buildResourceTableRows = (grouped) => {
  let html = '';
  for (const [service, items] of Object.entries(grouped)) {
    html += `<h3 style="color:#333;margin-top:16px;">${service.toUpperCase()} (${items.length})</h3>`;
    html += `<table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#f5f5f5;">
        <th style="padding:8px;text-align:left;">Resource Name</th>
        <th style="padding:8px;text-align:left;">Type</th>
        <th style="padding:8px;text-align:left;">ARN</th>
        <th style="padding:8px;text-align:left;">Tags</th>
      </tr></thead><tbody>`;
    for (const i of items) {
      const tagStr = i.tags ? Object.entries(i.tags).filter(([k]) => k !== 'owner').map(([k, v]) => `${k}=${v}`).join(', ') : 'N/A';
      html += `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${i.resourceName || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${i.resourceType || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:11px;word-break:break-all;">${i.resourceArn || i.arn || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:11px;">${tagStr}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  return html;
};

const buildReminderEmailHtml = ({ ownerEmail, cycleId, pendingCount, isUrgent, reviewUrl }) => `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    ${isUrgent ? '<div style="background:#d32f2f;color:#fff;padding:12px;text-align:center;font-weight:bold;">⚠️ OVERDUE SOON - 2 DAYS REMAINING</div>' : ''}
    <h2 style="color:#1976d2;">${cycleId} Access Recertification Reminder</h2>
    <p>Hi ${ownerEmail},</p>
    <p>You have <strong>${pendingCount}</strong> pending resource reviews that require your attention.</p>
    <p><a href="${reviewUrl}" style="background:${isUrgent ? '#d32f2f' : '#1976d2'};color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Complete Reviews</a></p>
    <p style="color:#666;font-size:12px;">Identity Governance System</p>
  </div>
`;

const buildEscalationEmailHtml = ({ ownerEmail, cycleId, pendingCount, reviewUrl }) => `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#d32f2f;color:#fff;padding:12px;text-align:center;font-weight:bold;">⚠️ ESCALATION - DEADLINE PASSED</div>
    <h2 style="color:#d32f2f;">${cycleId} Access Recertification Escalation</h2>
    <p><strong>${ownerEmail}</strong> has not completed their access recertification review.</p>
    <p><strong>${pendingCount}</strong> resources remain unreviewed past the deadline.</p>
    <p>Please take action to ensure compliance.</p>
    <p><a href="${reviewUrl}" style="background:#d32f2f;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">View Details</a></p>
    <p style="color:#666;font-size:12px;">Identity Governance System</p>
  </div>
`;

// Shared Helpers 

const getCycleSummary = async (cycleId) => {
  const result = await ddbClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `${KEY_PREFIXES.CYCLE}${cycleId}`, SK: SK_PREFIXES.SUMMARY },
  }));
  return result.Item;
};

const getReviewItemsByCycle = async (cycleId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.TYPE}RECERT_ITEM`,
      ':sk': cycleId,
    },
  }));
  return result.Items || [];
};

const groupByOwner = (items) => {
  const map = {};
  for (const item of items) {
    const key = item.ownerEmail || '';
    if (!map[key]) map[key] = [];
    map[key].push(item);
  }
  return map;
};

const sendEmail = async ({ to, subject, html, cycleId, ownerEmail, notificationType }) => {
  const now = new Date();
  try {
    await sesClient.send(new SendEmailCommand({
      Source: SENDER_EMAIL,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Html: { Data: html } },
      },
    }));
    await logNotification(cycleId, ownerEmail, notificationType, 'SENT', to, now);
  } catch (error) {
    const status = error.name === 'MessageRejected' ? 'BOUNCED' : 'FAILED';
    await logNotification(cycleId, ownerEmail, notificationType, status, to, now);
    console.error(JSON.stringify({
      errorCode: 'EMAIL_SEND_FAILED',
      to,
      notificationType,
      status,
      message: error.message,
      timestamp: toISOString(now),
    }));
  }
};

const logNotification = async (cycleId, ownerEmail, notificationType, status, email, now) => {
  try {
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
        SK: `NOTIFICATION#${cycleId}#${notificationType}#${toISOString(now)}`,
        entityType: ENTITY_TYPES.NOTIFICATION,
        cycleId,
        ownerEmail,
        notificationType,
        status,
        email,
        createdAt: toISOString(now),
        createdAtEpoch: toEpoch(now),
      },
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'NOTIFICATION_LOG_FAILED',
      message: error.message,
      timestamp: toISOString(now),
    }));
  }
};
