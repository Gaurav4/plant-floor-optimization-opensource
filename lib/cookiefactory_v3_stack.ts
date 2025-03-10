// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. 2021
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import {Fn} from 'aws-cdk-lib';
import * as lambdapython from "@aws-cdk/aws-lambda-python-alpha";
import * as iam from "aws-cdk-lib/aws-iam";
import {Effect, PolicyStatement} from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import * as timestream from "aws-cdk-lib/aws-timestream";
import * as assets from "aws-cdk-lib/aws-s3-assets";
import * as bedrockstack from "../lib/modules/bedrock/bedrock_stack"
import * as cognitostack from "../lib/modules/cognito/cognito_stack"
import * as twinmakerstack from "../lib/modules/twinmaker/twinmaker_stack"
import { CfnOutput } from "aws-cdk-lib/core";
import {Construct} from "constructs";
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as nagsuppressions_stack from './nagsuppressions';
import { aws_iottwinmaker as iottwinmaker } from 'aws-cdk-lib';

const sample_libs_root = path.join(__dirname);
const sample_modules_root = path.join(__dirname, "modules");
const cookiefactoryv3_tmdt = path.join(__dirname, "..", "..", "tmdt_project");
const cookiefactoryv3_synthetic_replay = path.join(__dirname, "..", "synthetic_replay_connector");
const RUM_APPLICATION_NAME = "cookiefactory-rum"
const USER_EMAIL = 'user@cookiefactory'

// verbose logger for debugging
// enable with `--context verboselogging=true` parameter to `cdk deploy`
class VerboseLogger {
    enabled: boolean;

    constructor(scope: Construct) {
        this.enabled = scope.node.tryGetContext("verboselogging") == 'true';
    }

    log(str: string) {
        if (this.enabled) {
            console.log(str);
        }
    }
}

export class CookieFactoryV3Stack extends cdk.Stack {
    cognitoResources: cognitostack.CognitoResources
    tmdtApp: twinmakerstack.TmdtApplication
    bedrockResources: bedrockstack.BedrockResources

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        
        const stack = cdk.Stack.of(this);

        nagsuppressions_stack.applySuppressions(this);

        // IoT TwinMaker target environment to deploy to
        const workspaceId = this.node.tryGetContext("iottwinmakerWorkspaceId");
        const workspaceBucket = this.node.tryGetContext("iottwinmakerWorkspaceBucket");

        if (!workspaceId || !workspaceBucket) {
            throw Error("'iottwinmakerWorkspaceId' and 'iottwinmakerWorkspaceBucket' must be provided via --context or specified in cdk.json")
        }

        // Some resources like Lambda function names have a name restriction of 64 characters, since we suffix these functions with the stack the name can't be too long
        if (`${this.stackName}`.length > 32) {
            throw Error('stackName too long: stackName is used in some generated resource names with length restrictions, please use a stackName no longer than 32 characters')
        }

        const corsRule: s3.CorsRule = {
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.DELETE, s3.HttpMethods.HEAD],
            allowedOrigins: ['*'],          
            allowedHeaders: ['*'],
            exposedHeaders: ['ETag']
          };

        // Create an S3 Bucket for vendor manuals and SOPs
        const twinmakerbucket = new s3.Bucket(this, 'cookiefactory-twinmaker', {
            bucketName: workspaceBucket,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            autoDeleteObjects: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            cors: [
                corsRule
            ]
        });

        const twinmakerRole = new iam.Role(this, "TwinMakerRole", {
            assumedBy: new iam.ServicePrincipal('iottwinmaker.amazonaws.com'),
          });
      
        twinmakerRole.addToPolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "iottwinmaker:*",
                "s3:*",
                "iotsitewise:*",
                "kinesisvideo:*",
                "iotevents:*",
                "lambda:invokeFunction"
            ],
            resources: ["*"],
            })
        );

        twinmakerRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "iam:PassRole"
                ],
                conditions: {
                    "StringEquals": {
                                "iam:PassedToService": "lambda.amazonaws.com"
                            }
                },
                resources: ["*"],
                })
            );

        const cfnWorkspace = new iottwinmaker.CfnWorkspace(this, 'TwinMakerWorkspace', {
            role: twinmakerRole.roleArn,
            s3Location: twinmakerbucket.bucketArn,
            workspaceId: workspaceId            
          });
        cfnWorkspace.node.addDependency(twinmakerbucket);
        cfnWorkspace.node.addDependency(twinmakerRole);

        // Create an S3 Bucket for vendor manuals and SOPs
        const bucket = new s3.Bucket(this, 'cookiefactory-documents', {
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL
        });

        // Deploy local document to the bucket
        const bucketdeploy = new s3deploy.BucketDeployment(this, 'DeployDocuments', {
            sources: [s3deploy.Source.asset('documents/')], 
            destinationBucket: bucket
        });

        // Create Cognito Resources in nested stack
        this.cognitoResources = new cognitostack.CognitoResources(this, "CognitoResources", {
            stack_name: this.stackName,
            user_email: USER_EMAIL,
            workspace_id: workspaceId,
            workspaceBucket: workspaceBucket,
            rumapplicationName: RUM_APPLICATION_NAME,
            account: this.account,
            region: this.region,            
        });
        
        // lambda layer for helper utilities for implementing UDQ Lambdas
        const udqHelperLayer = new lambdapython.PythonLayerVersion(this, 'udq_utils_layer', {
            entry: path.join(sample_libs_root, "udq_helper_utils"),
            compatibleRuntimes: [lambda.Runtime.PYTHON_3_10],
        });

        //region - sample infrastructure content for telemetry data in Timestream
        const timestreamDB = new timestream.CfnDatabase(this, "TimestreamTelemetry", {
            databaseName: `${this.stackName}`
        });
        const timestreamTable = new timestream.CfnTable(this, "Telemetry", {
            tableName: `Telemetry`,
            databaseName: `${timestreamDB.databaseName}`, // create implicit CFN dependency
            retentionProperties: {
                memoryStoreRetentionPeriodInHours: (24 * 30).toString(10),
                magneticStoreRetentionPeriodInDays: (24 * 30).toString(10)
            }
        });
        timestreamTable.node.addDependency(timestreamDB);

        const timestreamUdqRole = new iam.Role(this, 'timestreamUdqRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });
        timestreamUdqRole.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, "lambdaExecRole", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"))
        timestreamUdqRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonTimestreamReadOnlyAccess"))
        timestreamUdqRole.addToPolicy(
          new iam.PolicyStatement({
              actions: [
                  "iottwinmaker:GetEntity",
                  "iottwinmaker:GetWorkspace"],
              effect: iam.Effect.ALLOW,
              resources: [
                  `arn:aws:iottwinmaker:${this.region}:${this.account}:workspace/${workspaceId}/*`,
                  `arn:aws:iottwinmaker:${this.region}:${this.account}:workspace/${workspaceId}`
              ],
          })
        );

        const timestreamReaderUDQ = new lambdapython.PythonFunction(this, 'timestreamReaderUDQ', {
            entry: path.join(sample_modules_root,"timestream_telemetry","lambda_function"),
            layers: [
                udqHelperLayer,
            ],
            // name starts with "iottwinmaker-" so console-generated workspace role can invoke it
            functionName: `iottwinmaker-tsUDQ-${this.stackName}`,
            handler: "lambda_handler",
            index: 'udq_data_reader.py',
            memorySize: 256,
            role: timestreamUdqRole,
            runtime: lambda.Runtime.PYTHON_3_10,
            timeout: cdk.Duration.minutes(15),
            logRetention: logs.RetentionDays.ONE_DAY,
            environment: {
                "TIMESTREAM_DATABASE_NAME": `${timestreamDB.databaseName}`,
                "TIMESTREAM_TABLE_NAME": `${timestreamTable.tableName}`,
            }
        });

        //region - sample infrastructure content for synthetic cookieline telemetry data
        // https://aws-sdk-pandas.readthedocs.io/en/stable/layers.html
        const pandasLayer = lambda.LayerVersion.fromLayerVersionArn(this,
          'awsPandasLayer', `arn:aws:lambda:${this.region}:336392948345:layer:AWSSDKPandas-Python310:11`)

        var telemetryDataAsset = new assets.Asset(this, `demo-data-asset`, {
            path: path.join(cookiefactoryv3_synthetic_replay, "data.csv"),
        });

        // synthetic data lambda
        const syntheticDataUDQ = new lambdapython.PythonFunction(this, 'syntheticDataUDQ', {
            entry: cookiefactoryv3_synthetic_replay,
            layers: [
                udqHelperLayer,
                pandasLayer,
            ],
            // functionName starts with "iottwinmaker-" so console-generated workspace role can invoke it
            functionName: `iottwinmaker-synthUDQ-${this.stackName}`,
            handler: "lambda_handler",
            index: 'synthetic_udq_reader.py',
            memorySize: 1024,
            role: timestreamUdqRole,
            runtime: lambda.Runtime.PYTHON_3_10,
            timeout: cdk.Duration.minutes(15),
            logRetention: logs.RetentionDays.ONE_DAY,
            environment: {
                "TELEMETRY_DATA_FILE_NAME": 'demoTelemetryData.json',
                "TELEMETRY_DATA_TIME_INTERVAL_SECONDS": '10',
                "TELEMETRY_DATA_S3_FILE_BUCKET": telemetryDataAsset.s3BucketName,
                "TELEMETRY_DATA_S3_FILE_KEY": telemetryDataAsset.s3ObjectKey
            }
        });
        //endregion

        // TMDT application Nested Stack
        this.tmdtApp = new twinmakerstack.TmdtApplication(this, "TmdtApp", {
            workspace_id: workspaceId,
            workspaceBucket: workspaceBucket,
            tmdtRoot: cookiefactoryv3_tmdt,
            replacements: {
                "__FILL_IN_TS_DB__": `${timestreamDB.databaseName}`,
                "__TO_FILL_IN_TIMESTREAM_LAMBDA_ARN__": `${timestreamReaderUDQ.functionArn}`,
                "__TO_FILL_IN_SYNTHETIC_DATA_ARN__": `${syntheticDataUDQ.functionArn}`,
                '"targetEntityId"': '"TargetEntityId"',
            },
            account: this.account,
            region: this.region,

            // supply additional policies to the application lifecycle function to manage access for sample data assets
            additionalDataPolicies: [
                // permissions to write sample timestream data
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    resources: [`arn:aws:timestream:${this.region}:${this.account}:database/${timestreamDB.databaseName}/table/${timestreamTable.tableName}`],
                    actions: ["timestream:WriteRecords"]
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    resources: ["*"], // describe endpoints isn't resource-specific
                    actions: ["timestream:DescribeEndpoints",]
                }),
                // permissions to allow setting up sample video data in KVS
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    resources: [
                        `arn:aws:kinesisvideo:${this.region}:${this.account}:stream/cookiefactory_mixerroom_camera_01/*`,
                        `arn:aws:kinesisvideo:${this.region}:${this.account}:stream/cookiefactory_mixerroom_camera_02/*`,
                    ],
                    actions: [
                        "kinesisvideo:PutMedia",
                        "kinesisvideo:GetDataEndpoint",
                        "kinesisvideo:CreateStream",
                    ]
                })
            ]
        });
        this.tmdtApp.node.addDependency(timestreamTable);

        // Create Bedrock Resources in nested stack
        this.bedrockResources = new bedrockstack.BedrockResources(this, "BedrockResources", {
            stack_name: this.stackName,
            documentBucket: bucket,
            account: this.account,
            region: this.region,            
        });
        this.bedrockResources.node.addDependency(bucket);

        // Export values

        // Import values from Cognito stqck to parent stack
        new CfnOutput(this, "UserPoolId", {
            value: this.cognitoResources.userPoolId
        });
        new CfnOutput(this, "ClientId", {
            value: this.cognitoResources.clientId
        });
        //new CfnOutput(this, "ClientSecret", {
        //    value: this.cognitoResources.clientSecret
        //});
        new CfnOutput(this, "ClientDomain", {
            value: this.cognitoResources.clientDomain
        });
        new CfnOutput(this, "IdentityPoolId", {
            value: this.cognitoResources.identityPoolId
        });
        new CfnOutput(this, "CognitoGuestArn", {
            value: this.cognitoResources.cognitoGuestArn
        });
        new CfnOutput(this, "DocumentBucketArn", {
            value: bucket.bucketArn
        });
        new CfnOutput(this, "KnowledgeBaseId", {
            value: this.bedrockResources.knowledgeBaseId
        });
        new CfnOutput(this, "DatasourceId", {
            value: this.bedrockResources.datasourceId
        });
        new CfnOutput(this, "AWSRumApplicationName", {
            value: RUM_APPLICATION_NAME,
        });
        new CfnOutput(this, "AWSRumApplicationId", {
            value: this.cognitoResources.awsRumApplicationId
        });                
    }
}
