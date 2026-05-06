/**
 * AWS Amplify Auth configuration for Cognito User Pool.
 * Reads from Vite environment variables.
 * @module config/amplify
 */

const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
      loginWith: {
        email: true,
      },
    },
  },
};

export default amplifyConfig;
