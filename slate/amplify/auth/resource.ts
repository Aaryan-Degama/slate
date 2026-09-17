import { defineAuth } from '@aws-amplify/backend';
import { preSignUp } from './pre-sign-up/resource';

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 *
 * Sign-up is gated to @iiita.ac.in emails by the preSignUp trigger
 * (amplify/auth/pre-sign-up/handler.ts) — that's the closed-community
 * boundary. The `role` custom attribute gates only who may hit
 * Confirm & Notify (enforced separately via Cedar).
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  userAttributes: {
    'custom:role': {
      dataType: 'String',
      mutable: true,
    },
  },
  triggers: {
    preSignUp,
  },
});
