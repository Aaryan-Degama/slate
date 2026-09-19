#!/usr/bin/env bash
# Build the frontend and publish it to Amplify Hosting (manual deploy, no
# Git connection): https://main.d1hpc7rjskshni.amplifyapp.com
# Uses the backend in amplify_outputs.json. Needs the `slate` AWS profile.
# APP_ID/BRANCH/REGION can be overridden via env for a different deployment.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_ID=${APP_ID:-d1hpc7rjskshni}
BRANCH=${BRANCH:-main}
REGION=${REGION:-ap-south-1}
export AWS_PROFILE=${AWS_PROFILE:-slate}

npm run build
ZIP=$(mktemp -d)/site.zip
(cd dist && zip -qr "$ZIP" .)

read -r JOB URL < <(aws amplify create-deployment --region "$REGION" --app-id "$APP_ID" --branch-name "$BRANCH" \
  --query "[jobId,zipUploadUrl]" --output text)
curl -sf -X PUT -H "Content-Type: application/zip" --data-binary @"$ZIP" "$URL"
aws amplify start-deployment --region "$REGION" --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB" >/dev/null

for _ in $(seq 1 60); do
  STATUS=$(aws amplify get-job --region "$REGION" --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB" \
    --query "job.summary.status" --output text)
  [[ $STATUS == SUCCEED || $STATUS == FAILED ]] && break
  sleep 5
done
echo "deploy $JOB: $STATUS -> https://$BRANCH.$APP_ID.amplifyapp.com"
[[ $STATUS == SUCCEED ]]
