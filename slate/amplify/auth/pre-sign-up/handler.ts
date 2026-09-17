import type { PreSignUpTriggerHandler } from 'aws-lambda';

const ALLOWED_DOMAIN = 'iiita.ac.in';

export const handler: PreSignUpTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email ?? '';
  const domain = email.split('@')[1]?.toLowerCase();

  if (domain !== ALLOWED_DOMAIN) {
    throw new Error(`Sign-up is restricted to @${ALLOWED_DOMAIN} email addresses.`);
  }

  return event;
};
