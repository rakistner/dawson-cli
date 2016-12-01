
import { oneLineTrim } from 'common-tags';
import Observable from 'zen-observable';
import AWS from 'aws-sdk';
import Table from 'cli-table';
import moment from 'moment';

import { debug, error } from '../logger';

import {
  stackUpload
} from '../libs/stackUpload';

export const AWS_REGION = AWS.config.region;
const cloudformation = new AWS.CloudFormation({ apiVersion: '2010-05-15' });

const SAFE_STACK_POLICY = {
  // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/protect-stack-resources.html
  // DynamoDB tables & S3 Buckets shall not be deleted
  'Statement': [{
    'Effect': 'Deny',
    'Principal': '*',
    'Action': ['Update:Replace', 'Update:Delete'],
    'Resource': '*',
    'Condition': {
      'StringEquals': {
        'ResourceType': [
          'AWS::DynamoDB::Table',
          'AWS::ApiGateway::RestApi',
          'AWS::CloudFront::Distribution',
          'AWS::S3::Bucket'
        ]
      }
    }
  }, {
    'Effect': 'Allow',
    'Principal': '*',
    'Action': 'Update:*',
    'Resource': '*'
  }]
};

const UNSAFE_STACK_POLICY = {
  'Statement': [{
    'Effect': 'Allow',
    'Action': 'Update:*',
    'Principal': '*',
    'Resource': '*'
  }]
};

export function templateStackName ({ appName, stage }) {
  const stageUCFirst = stage
    ? (stage[0].toUpperCase() + stage.substring(1))
    : '';
  return `${appName}${stageUCFirst}`;
}

function checkStackExists ({ stackName }) {
  return new Promise((resolve, reject) => {
    cloudformation.describeStacks({
      StackName: stackName
    }, (err, data) => {
      if (err || !data.Stacks.find(s => s.StackName === stackName)) {
        debug('No existing stack found, creating new');
        return resolve(false);
      }
      debug('Updating existing stack');
      return resolve(true);
    });
  });
}

export async function buildStack ({ supportBucketName = null, stackName, cfTemplateJSON, inline = false }) {
  const templateSource = inline
    ? ({
      TemplateBody: cfTemplateJSON
    })
    : ({
      TemplateURL: await stackUpload({
        bucketName: supportBucketName,
        stackBody: cfTemplateJSON
      })
    });
  var params = {
    StackName: stackName,
    Capabilities: ['CAPABILITY_IAM'],
    Parameters: [],
    Tags: [{
      Key: 'createdBy',
      Value: 'danilo'
    }],
    ...templateSource,
    StackPolicyBody: JSON.stringify(SAFE_STACK_POLICY),
    OnFailure: 'DO_NOTHING' // deleted when updating
  };
  return params;
}

async function doCreateChangeSet ({ stackName, cfParams }) {
  var params = {
    ChangeSetName: 'DawsonUserChangeSet' + Date.now(),
    StackName: stackName,
    Capabilities: [
      'CAPABILITY_IAM'
    ],
    TemplateBody: cfParams.TemplateBody,
    TemplateURL: cfParams.TemplateURL
  };
  const result = await cloudformation.createChangeSet(params).promise();
  const changeSetId = result.Id;
  let status = null;
  while (status !== 'CREATE_COMPLETE') {
    const description = await cloudformation.describeChangeSet({
      ChangeSetName: changeSetId
    }).promise();
    if (description.Status === 'FAILED') {
      if (description.StatusReason.includes('didn\'t contain changes')) {
        // "The submitted information didn\'t contain changes. Submit different information to create a change set."
        return false;
      }
      debug('Cannot crate changeset', description);
      throw new Error('Change Set failed to create');
    } else if (description.Status === 'CREATE_COMPLETE') {
      const debugStr = description.Changes
      .sort((change1, change2) => (
        (change2.ResourceChange.Action + change2.ResourceChange.LogicalResourceId) <
        (change1.ResourceChange.Action + change1.ResourceChange.LogicalResourceId)
        ? 1 : -1))
      .map(change => {
        let color;
        switch (change.ResourceChange.Action) {
          case 'Add':
            color = 'green';
            break;
          case 'Modify':
            color = 'yellow';
            break;
          case 'Remove':
            color = 'red';
            break;
        }
        return `${change.ResourceChange.LogicalResourceId[color]}`;
      }).join(', ');
      debug('  resources affected by this update:', debugStr);
    } else {
      // wait and loop
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    status = description.Status;
  }
  return changeSetId;
}

async function doExecuteChangeSet ({ changeSetId }) {
  return await cloudformation.executeChangeSet({
    ChangeSetName: changeSetId
  }).promise();
}

export async function createOrUpdateStack ({ stackName, cfParams, dryrun, ignoreNoUpdates = false }) {
  const stackExists = await checkStackExists({ stackName });
  let updateStackResponse;

  try {
    if (stackExists) {
      delete cfParams.OnFailure;
      const changeSetId = await doCreateChangeSet({ stackName, cfParams });
      if (changeSetId) {
        // only if the ChangeSet has been created successfully
        await doExecuteChangeSet({ changeSetId });
      }
    } else {
      updateStackResponse = await cloudformation.createStack(cfParams).promise();
    }
  } catch (err) {
    if (ignoreNoUpdates && err.message.match(/No updates are to be performed/i)) {
      debug('This stack does not need any update'.gray);
      return {};
    }
    error('Stack update not accepted:'.bold.red, err.message.red);
    throw err;
  }

  return updateStackResponse;
}

export async function removeStackPolicy ({ stackName }) {
  return await cloudformation.setStackPolicy({
    StackName: stackName,
    StackPolicyBody: JSON.stringify(UNSAFE_STACK_POLICY)
  }).promise();
}

export async function restoreStackPolicy ({ stackName }) {
  return await cloudformation.setStackPolicy({
    StackName: stackName,
    StackPolicyBody: JSON.stringify(SAFE_STACK_POLICY)
  }).promise();
}

export function getStackOutputs ({ stackName }) {
  return cloudformation.describeStacks({ StackName: stackName }).promise()
  .then(data => data.Stacks[0].Outputs);
}

export function getStackResources ({ stackName }) {
  return cloudformation.describeStackResources({ StackName: stackName }).promise()
  .then(data => data.StackResources);
}

let LAST_STACK_REASON = '';
export function waitForUpdateCompleted (args) {
  const startTimestamp = Date.now();
  return new Promise(resolve => {
    uiPollStackStatusHelper(args, startTimestamp, (err) => {
      if (err) {
        throw err;
      }
      resolve();
    });
  });
}
export function observerForUpdateCompleted (args) {
  const startTimestamp = Date.now();
  return new Observable(observer =>
    uiPollStackStatusHelper(args, startTimestamp, (err) => {
      if (err) {
        throw err;
      }
      observer.complete();
    }, (status, reason) => observer.next(`status: ${status} ${reason ? `(${reason})` : ''}`))
  );
}
function uiPollStackStatusHelper ({ stackName }, startTimestamp, done, onProgress = () => {}) {
  cloudformation.describeStacks({
    StackName: stackName
  }, (err, data) => {
    if (err) {
      error('Cannot call describeStacks', err.message);
      throw err;
    }
    const status = data.Stacks[0].StackStatus;
    const reason = data.Stacks[0].StackStatusReason;
    onProgress(status, reason);
    if (reason) { LAST_STACK_REASON = reason; }
    let action = '';
    switch (status) {
      case 'CREATE_IN_PROGRESS':
      case 'UPDATE_IN_PROGRESS':
        action = 'wait';
        break;
      case 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS':
        action = 'wait_ok';
        break;
      case 'CREATE_COMPLETE':
      case 'UPDATE_COMPLETE':
        action = 'succeed';
        break;
      case 'CREATE_FAILED':
      case 'ROLLBACK_FAILED':
      case 'ROLLBACK_COMPLETE':
      case 'DELETE_FAILED':
      case 'DELETE_COMPLETE':
      case 'UPDATE_ROLLBACK_FAILED':
      case 'UPDATE_ROLLBACK_COMPLETE':
        action = 'error';
        break;
      case 'ROLLBACK_IN_PROGRESS':
      case 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS':
      case 'UPDATE_ROLLBACK_IN_PROGRESS':
      case 'DELETE_IN_PROGRESS':
        action = 'wait_error';
        break;
      default:
        throw new Error('Unknown CloudFormation stack status: ' + status);
    }
    if (action === 'wait') {
      setTimeout(() => uiPollStackStatusHelper(...arguments), 1000);
      return;
    }
    if (action === 'wait_error') {
      setTimeout(() => uiPollStackStatusHelper(...arguments), 1000);
      return;
    }
    if (action === 'wait_ok') {
      setTimeout(() => uiPollStackStatusHelper(...arguments), 1000);
      return;
    }
    if (action === 'error') {
      error(`\nStack update failed:`, LAST_STACK_REASON);
      cloudformation.describeStackEvents({
        StackName: stackName
      })
      .promise()
      .then(describeResult => {
        const failedEvents = describeResult.StackEvents
          .filter(e => e.Timestamp >= startTimestamp)
          .filter(e => e.ResourceStatus.includes('FAILED'))
          .map(e => ([
            moment(e.Timestamp).fromNow(),
            e.ResourceStatus || '',
            e.ResourceStatusReason || '',
            e.LogicalResourceId || ''
          ]));
        const table = new Table({
          head: ['Timestamp', 'Status', 'Reason', 'Logical Id']
        });
        table.push(...failedEvents);
        error('\nThe stack update has failed.');
        if (describeResult.StackEvents[0]) {
          error('You may further inspect stack events from the console at this link:',
            oneLineTrim`https://${AWS_REGION}.console.aws.amazon.com/cloudformation/home
            ?region=${AWS_REGION}#/stacks?tab=events
              &stackId=${encodeURIComponent(describeResult.StackEvents[0].StackId)}
            `);
        }
        error(table.toString());
        done(new Error('Stack update failed:' + LAST_STACK_REASON), null);
        return;
      });
    }
    if (action === 'succeed') {
      debug(`\nStack update completed!`);
      done(null, data.Stacks[0].Outputs);
      return;
    }
  });
}
