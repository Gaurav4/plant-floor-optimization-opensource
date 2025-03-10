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

export WS_S3_BUCKET=twinmaker-$AWS_DEFAULT_REGION-$(echo "$WORKSPACE_ID" | tr '[:upper:]' '[:lower:]')-$CDK_DEFAULT_ACCOUNT
echo "WS_S3_BUCKET: ${WS_S3_BUCKET}"

# GetAuthorizationToken command is only supported in us-east-1
aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws

npm install

DOCKER_DEFAULT_PLATFORM=linux/amd64

cdk deploy \
    --context stackName="${CFN_STACK_NAME}" \
    --context iottwinmakerWorkspaceId="$WORKSPACE_ID" \
    --context iottwinmakerWorkspaceBucket="$WS_S3_BUCKET" --require-approval never

# TODO fix in TmdtApp - handling for tiles assets
aws s3 cp --recursive ../tmdt_project/3d_models/ s3://${WS_S3_BUCKET}

# Start ingestion job for bedrock knowledge base
CFN_STACK_OUTPUTS=$(aws cloudformation describe-stacks --stack-name "${CFN_STACK_NAME}" --output json | jq '.Stacks[0].Outputs')
KNOWLEDGE_BASE_ID=$(echo $CFN_STACK_OUTPUTS | jq -r '.[] | select(.OutputKey=="KnowledgeBaseId").OutputValue')
DATA_SOURCE_ID=$(echo $CFN_STACK_OUTPUTS | jq -r '.[] | select(.OutputKey=="DatasourceId").OutputValue')
aws bedrock-agent start-ingestion-job --knowledge-base-id "$KNOWLEDGE_BASE_ID" --data-source-id "$DATA_SOURCE_ID"

# echo exports to use for app
echo "AWS resources setup complete"