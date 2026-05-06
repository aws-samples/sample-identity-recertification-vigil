/**
 * DynamoDB DocumentClient initialization.
 * Client is created at module scope for reuse across Lambda invocations.
 * @module shared/dynamo-client
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME || 'IdentityGovernanceTable';

const marshallOptions = {
  convertEmptyValues: false,
  removeUndefinedValues: true,
  convertClassInstanceToMap: true,
};

const unmarshallOptions = {
  wrapNumbers: false,
};

const ddbClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({}),
  { marshallOptions, unmarshallOptions }
);

export { ddbClient, TABLE_NAME };
