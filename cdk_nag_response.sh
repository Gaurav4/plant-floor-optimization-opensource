#!/bin/sh

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# List of environment variables to check
vars=("AWS_DEFAULT_REGION" "CDK_DEFAULT_ACCOUNT" "WORKSPACE_ID" "CFN_STACK_NAME")

# Loop through list and check if each variable is set
for var in "${vars[@]}"
do
  if [ -z "${!var}" ] 
  then
    echo "Environment variable $var is not set"
    exit 1
  else
    echo "Environment variable $var is set to ${!var}"  
  fi
done

set -e
trap 'echo "******* FAILED *******" 1>&2' ERR

export WS_S3_BUCKET=twinmaker-cfv3-$AWS_DEFAULT_REGION-$CDK_DEFAULT_ACCOUNT-$(echo "$WORKSPACE_ID" | tr '[:upper:]' '[:lower:]')
echo "WS_S3_BUCKET: ${WS_S3_BUCKET}"

# GetAuthorizationToken command is only supported in us-east-1
aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws

npm install

cdk synth \
    --context stackName="${CFN_STACK_NAME}" \
    --context iottwinmakerWorkspaceId="$WORKSPACE_ID" \
    --context iottwinmakerWorkspaceBucket="$WS_S3_BUCKET" --require-approval never
