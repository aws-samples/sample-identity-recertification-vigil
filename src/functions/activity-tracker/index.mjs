/**
 * Activity Tracker Lambda - stub for MVP deployment.
 * Full implementation in user-activity-tracking spec.
 * @module functions/activity-tracker
 */

import { successResponse, errorResponse } from '../../shared/constants.mjs';

export const handler = async (event) => {
  // Handle Cognito PostAuthentication trigger
  if (event.triggerSource) {
    console.log(JSON.stringify({ action: 'ACTIVITY_TRACKER_STUB', triggerSource: event.triggerSource, timestamp: new Date().toISOString() }));
    return event;
  }
  // Handle API calls
  if (event.httpMethod) {
    return errorResponse(501, 'Activity tracker not yet implemented');
  }
  // Handle scheduled events
  console.log(JSON.stringify({ action: 'ACTIVITY_TRACKER_STUB', timestamp: new Date().toISOString() }));
};
