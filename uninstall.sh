#!/bin/sh

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# List of environment variables to check
vars=("AWS_DEFAULT_REGION" "WORKSPACE_ID" "CFN_STACK_NAME")

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

echo "deleting CFN stack ${CFN_STACK_NAME}..."
aws cloudformation delete-stack --stack-name "${CFN_STACK_NAME}" --region ${AWS_DEFAULT_REGION} && aws cloudformation wait stack-delete-complete --stack-name "${CFN_STACK_NAME}" --region ${AWS_DEFAULT_REGION}
