import { defineAuth } from '@aws-amplify/backend';
import { preSignUp } from './pre-sign-up/resource';

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 *
 * Sign-up is gated to @iiita.ac.in emails by the preSignUp trigger
 * (amplify/auth/pre-sign-up/handler.ts) — that's the closed-community
 * boundary. Who may change a section's timetable (its CR) is decided by
 * the Cedar policy in amplify/functions/section-changes/policy.cedar.
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
  // Admin rights come from this group, not the User.role field: users can
  // edit their own User row, but only the AWS account can add group members.
  groups: ['ADMIN'],
  triggers: {
    preSignUp,
  },
});
