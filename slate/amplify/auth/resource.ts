import { defineAuth } from '@aws-amplify/backend';
import { preSignUp } from './pre-sign-up/resource';

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 *
 * Sign-up is gated to @iiita.ac.in emails by the preSignUp trigger
 * (amplify/auth/pre-sign-up/handler.ts) — that's the closed-community
 * boundary. The `role` custom attribute gates only who may hit
 * Confirm (enforced by the Cedar policy in
 * amplify/functions/confirm-slot/confirm.cedar).
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
  // Admin/faculty rights come from these groups, not the User.role field:
  // users can edit their own User row, but only the AWS account can add
  // group members.
  groups: ['ADMIN', 'FACULTY'],
  triggers: {
    preSignUp,
  },
});
