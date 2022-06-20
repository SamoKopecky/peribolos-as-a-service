import { Probot } from 'probot';
import { Router } from 'express';
import { exposeMetrics, useCounter } from '@open-services-group/probot-metrics';
import {
  APIS,
  createTokenSecret,
  deleteTokenSecret,
  getNamespace,
  getTokenSecretName,
  updateTokenSecret,
  useApi,
} from '@open-services-group/probot-kubernetes';

const generateTaskPayload = (name: string, context: any) => ({
  apiVersion: 'tekton.dev/v1beta1',
  kind: 'TaskRun',
  metadata: {
    generateName: name + '-',
  },
  spec: {
    taskRef: {
      name,
    },
    params: [
      {
        name: 'SECRET_NAME',
        value: getTokenSecretName(context),
      },
    ],
  },
});

const getTaskName = async (taskRun: Promise<any>) =>
  (await taskRun).body.metadata.name;

const checkTaskStatus = async (
  taskName: string,
  log: any,
  errorCountLimit: number = 50,
  repeatPeriod: number = 1000
) => {
  var errorCount = 0;
  return new Promise((taskRunResultHandler) => {
    const id = setInterval(async () => {
      errorCount++;
      let reason = '';

      // Get task status
      const taskInfo: any = await useApi(
        APIS.CustomObjectsApi
      ).getNamespacedCustomObjectStatus(
        'tekton.dev',
        'v1beta1',
        getNamespace(),
        'taskruns',
        taskName
      );

      try {
        reason = taskInfo.body.status.conditions[0].reason;
      } catch (e) {
        log.error(e);
      }

      if (reason === 'Failed' || errorCount >= errorCountLimit) {
        taskRunResultHandler(true);
        clearInterval(id);
      } else if (reason === 'Succeeded') {
        taskRunResultHandler(false);
        clearInterval(id);
      }
    }, repeatPeriod);
  });
};

const handleTaskRunResult = async (
  failed: boolean,
  taskName: string,
  log: any,
  context: any
) => {
  if (failed === true) {
    log.warn(taskName + ' failed.');

    // Used for org name
    const appSecret = await useApi(APIS.CoreV1Api).readNamespacedSecret(
      getTokenSecretName(context),
      getNamespace()
    );

    // Used for pod name
    const taskRunObject: any = await useApi(
      APIS.CustomObjectsApi
    ).getNamespacedCustomObject(
      'tekton.dev',
      'v1beta1',
      getNamespace(),
      'taskruns',
      taskName
    );

    // Get taskRun logs
    const podObject = await useApi(APIS.CoreV1Api).readNamespacedPodLog(
      taskRunObject.body.status.podName,
      getNamespace()
    );

    context.octokit.issues.create({
      owner: Buffer.from(
        <string>appSecret?.body?.data?.orgName,
        'base64'
      ).toString('binary'),
      repo: '.github',
      title: taskName + ' failed',
      body:
        'Logs for `' +
        taskName +
        '`:\n' +
        '```json\n' +
        podObject.body +
        '\n```',
    });
  } else {
    log.info(taskName + ' succeeded.');
  }
};

export default (
  app: Probot,
  {
    getRouter,
  }: { getRouter?: ((path?: string | undefined) => Router) | undefined }
) => {
  // Expose additional routes for /healthz and /metrics
  if (!getRouter) {
    app.log.error('Missing router.');
    return;
  }
  const router = getRouter();
  router.get('/healthz', (_, response) => response.status(200).send('OK'));
  exposeMetrics(router, '/metrics');

  // Register tracked metrics
  const numberOfInstallTotal = useCounter({
    name: 'num_of_install_total',
    help: 'Total number of installs received',
    labelNames: [],
  });
  const numberOfUninstallTotal = useCounter({
    name: 'num_of_uninstall_total',
    help: 'Total number of uninstalls received',
    labelNames: [],
  });
  const numberOfActionsTotal = useCounter({
    name: 'num_of_actions_total',
    help: 'Total number of actions received',
    labelNames: ['install', 'action'],
  });
  const operationsTriggered = useCounter({
    name: 'operations_triggered',
    help: 'Metrics for action triggered by the operator with respect to the kubernetes operations.',
    labelNames: ['install', 'operation', 'status', 'method'],
  });

  // Simple callback wrapper - executes and async operation and based on the result it inc() operationsTriggered counted
  const wrapOperationWithMetrics = (callback: Promise<any>, labels: any) => {
    const response = callback
      .then(() => ({
        status: 'Succeeded',
      }))
      .catch(() => ({
        status: 'Failed',
      }));

    operationsTriggered
      .labels({
        ...labels,
        ...response,
        operation: 'k8s',
      })
      .inc();
    return callback;
  };

  app.onAny((context: any) => {
    // On any event inc() the counter
    numberOfActionsTotal
      .labels({
        install: context.payload.installation.id,
        action: context.payload.action,
      })
      .inc();
  });

  app.on('installation.created', async (context: any) => {
    numberOfInstallTotal.labels({}).inc();

    // Iterate over the list of repositories for .github repo
    const repo_exist = Boolean(
      context.payload.repositories?.find((r: any) => r.name === '.github')
    );

    if (!repo_exist) {
      app.log.info("Creating '.github' repository.");

      context.octokit.repos
        .createInOrg({
          org: context.payload.installation.account.login,
          name: '.github',
        })
        .catch((err: any) => {
          app.log.warn(err, 'Error creating repository');
        });
    }

    // Create secret holding the access token
    wrapOperationWithMetrics(createTokenSecret(context), {
      install: context.payload.installation.id,
      method: 'createSecret',
    });

    // Trigger dump-config taskrun
    const taskName = await getTaskName(
      wrapOperationWithMetrics(
        useApi(APIS.CustomObjectsApi).createNamespacedCustomObject(
          'tekton.dev',
          'v1beta1',
          getNamespace(),
          'taskruns',
          generateTaskPayload('peribolos-dump-config', context)
        ),
        {
          install: context.payload.installation.id,
          method: 'scheduleDumpConfig',
        }
      )
    );
    await checkTaskStatus(taskName, app.log).then((failed) => {
      handleTaskRunResult(<boolean>failed, taskName, app.log, context);
    });
  });

  app.on('push', async (context: any) => {
    // Check if 'peribolos.yaml' was modified
    const modified = Boolean(
      context.payload.commits
        ?.reduce(
          (acc: any, commit: any) => [
            ...acc,
            ...commit.added,
            ...commit.modified,
            ...commit.removed,
          ],
          [] as string[]
        )
        .find((name: string) => name == 'peribolos.yaml')
    );
    if (!modified) {
      app.log.info('No changes in peribolos.yaml, skipping peribolos run');
      return;
    }

    // Update token in case it expired
    wrapOperationWithMetrics(updateTokenSecret(context), {
      install: context.payload.installation.id,
      method: 'updateSecret',
    });

    const taskName = await getTaskName(
      wrapOperationWithMetrics(
        useApi(APIS.CustomObjectsApi).createNamespacedCustomObject(
          'tekton.dev',
          'v1beta1',
          getNamespace(),
          'taskruns',
          generateTaskPayload('peribolos-run', context)
        ),
        {
          install: context.payload.installation.id,
          method: 'schedulePushTask',
        }
      )
    );

    await checkTaskStatus(taskName, app.log).then((failed) => {
      handleTaskRunResult(<boolean>failed, taskName, app.log, context);
    });
  });

  app.on('installation.deleted', async (context: any) => {
    numberOfUninstallTotal.labels({}).inc();

    // Delete secret containing the token
    wrapOperationWithMetrics(deleteTokenSecret(context), {
      install: context.payload.installation.id,
      method: 'deleteSecret',
    });
  });
};
