const { events, Job, Group } = require('brigadier');
const kubernetes = require('@kubernetes/client-node');
const yaml = require('js-yaml');
const fetch = require('node-fetch');
const ulid = require('ulid');
const crypto = require('crypto');

const k8sClient = kubernetes.Config.defaultClient();

const BRIGADE_NAMESPACE = 'brigade';
const GITHUB_API_URL = 'https://api.github.com/repos';

const protectedEnvironment = (namespaceName) => {
  const protectedNamespaces = [
    'default',
    'kube-public',
    'kube-system',
    'brigade',
    'prod',
    'stage',
  ];

  if (protectedNamespaces.includes(namespaceName)) {
    return true;
  }
  return false;
};

const createNamespace = async (namespaceName) => {
  const existingNamespace = await k8sClient.listNamespace(
    true, '', `metadata.name=${namespaceName}`,
  );
  if (existingNamespace.body.items.length) {
    console.log(`Namespace "${namespaceName}" already exists`);
    return;
  }

  console.log(`Creating namespace "${namespaceName}"`);
  const namespace = new kubernetes.V1Namespace();
  namespace.metadata = new kubernetes.V1ObjectMeta();
  namespace.metadata.name = namespaceName;

  await k8sClient.createNamespace(namespace);
  console.log('Done creating new namespace');
};

const createEnvironmentConfigMap = async (name, projects) => {
  console.log('creating environment configMap');
  const configMap = new kubernetes.V1ConfigMap();
  const metadata = new kubernetes.V1ObjectMeta();
  metadata.name = `environment-config-${name}`;
  metadata.namespace = BRIGADE_NAMESPACE;
  metadata.labels = {
    type: 'preview-environment-config',
    environmentName: name,
  };
  configMap.metadata = metadata;
  configMap.data = {
    environment: yaml.dump(projects),
  };

  try {
    await k8sClient.createNamespacedConfigMap(BRIGADE_NAMESPACE, configMap);
  } catch (error) {
    if (error.body && error.body.code === 409) {
      await k8sClient.replaceNamespacedConfigMap(
        configMap.metadata.name, BRIGADE_NAMESPACE, configMap,
      );
    } else {
      throw error;
    }
  }
  console.log('done creating environment configMap');
};

const ensurePodIsRunning = async (namespace, appLabel) => {
  let podIsRunning = false;
  while (!podIsRunning) {
    const pod = await k8sClient.listNamespacedPod(
      namespace, undefined, undefined, 'status.phase=Running', false, `app=${appLabel}`,
    );
    if (pod.body.items.length) {
      console.log(`Pod ${appLabel} is ready`);
      podIsRunning = true;
    } else {
      console.log(`Waiting for ${appLabel} pod to be ready`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
};

const deployDependencies = async (namespace) => {
  console.log('deploying dependencies');
  const postgresql = new Job('postgresql', 'jakubborys/ditc-brigade-worker:latest');
  postgresql.storage.enabled = false;
  postgresql.imageForcePull = true;
  postgresql.tasks = [
    `helm upgrade ${namespace}-postgresql stable/postgresql \
    --install --namespace=${namespace} \
    --set fullnameOverride=postgresql \
    --set postgresqlDatabase=postgresql \
    --set postgresqlPassword=password \
    --set readinessProbe.initialDelaySeconds=60;`,
  ];

  const rabbitMQ = new Job('rabbitmq', 'jakubborys/ditc-brigade-worker:latest');
  rabbitMQ.storage.enabled = false;
  rabbitMQ.imageForcePull = true;
  rabbitMQ.tasks = [
    `helm upgrade ${namespace}-rabbitmq stable/rabbitmq-ha \
    --install --namespace=${namespace} \
    --set fullnameOverride=rabbitmq \
    --set image.tag=3.7-management-alpine \
    --set rbac.create=false \
    --set replicaCount=1 \
    --set persistentVolume.enabled=true \
    --set updateStrategy=RollingUpdate \
    --set rabbitmqPassword=password \
    --set rabbitmqMemoryHighWatermarkType=relative \
    --set rabbitmqMemoryHighWatermark=0.5`,
  ];
  const redis = new Job('redis', 'jakubborys/ditc-brigade-worker:latest');
  redis.storage.enabled = false;
  redis.imageForcePull = true;
  redis.tasks = [
    `helm upgrade ${namespace}-redis stable/redis \
    --install --namespace ${namespace} \
    --set fullnameOverride=redis \
    --set password=password \
    --set cluster.enabled=false`,
  ];
  const telepresence = new Job(
    'telepresence', 'jakubborys/ditc-brigade-worker:latest',
  );
  telepresence.storage.enabled = false;
  telepresence.imageForcePull = true;
  telepresence.tasks = [
    'cd /src',
    `helm upgrade ${namespace}-telepresence charts/telepresence \
    --install --namespace ${namespace}`,
  ];
  await Group.runAll([postgresql, rabbitMQ, redis, telepresence]);
  await new Promise(resolve => setTimeout(resolve, 10000));
  await ensurePodIsRunning(namespace, 'postgresql');
  await ensurePodIsRunning(namespace, 'rabbitmq-ha');
  await ensurePodIsRunning(namespace, 'redis');
  console.log('done deploying dependencies');
};

const deployProjects = async (environmentName) => {
  const environmentConfigMap = await k8sClient.readNamespacedConfigMap(
    `environment-config-${environmentName}`, BRIGADE_NAMESPACE,
  );
  const environmentsConfig = yaml.safeLoad(
    environmentConfigMap.body.data.environment,
  );
  for (const key of Object.keys(environmentsConfig)) {
    const projectConfig = environmentsConfig[key];

    const url = `${GITHUB_API_URL}/${projectConfig.org}/${projectConfig.repo}`;
    const tagUrl = `${url}/git/refs/tags/${projectConfig.tag}`;
    const response = await fetch(
      tagUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `token ${process.env.BRIGADE_REPO_AUTH_TOKEN}`,
        },
      },
    );

    if (!response.ok && response.status === 404) {
      console.log(
        `'${projectConfig.tag}' tag not found in `
        + `${projectConfig.org}/${projectConfig.repo} repository`,
      );
    } else {
      console.log(
        `Triggering deployment of '${projectConfig.repo}' for tag '${projectConfig.tag}'`,
      );
      const commit = await response.json();
      const gitSha = commit.object.sha;

      const projectSha = crypto.createHash('sha256').update(
        `${projectConfig.org}/${projectConfig.repo}`,
      ).digest('hex').substring(0, 54);
      const projectId = `brigade-${projectSha}`;
      const buildId = ulid().toLowerCase();
      const buildName = `environment-worker-${buildId}`;
      const deployEventSecret = new kubernetes.V1Secret();
      deployEventSecret.metadata = new kubernetes.V1ObjectMeta();
      deployEventSecret.metadata.name = buildName;
      deployEventSecret.metadata.labels = {
        build: buildId,
        component: 'build',
        heritage: 'brigade',
        project: projectId,
      };
      deployEventSecret.type = 'brigade.sh/build';
      deployEventSecret.stringData = {
        build_id: buildName,
        build_name: buildName,
        commit_id: gitSha,
        commit_ref: projectConfig.tag,
        event_provider: 'brigade-cli',
        event_type: 'exec',
        log_level: 'log',
        payload: `{"name": "${environmentName}"}`,
        project_id: projectId,
        script: '',
      };
      await k8sClient.createNamespacedSecret(BRIGADE_NAMESPACE, deployEventSecret);
    }
  }
};

const provisionEnvironment = async (environmentName, projects) => {
  await createNamespace(environmentName);
  await createEnvironmentConfigMap(environmentName, projects);
  await deployDependencies(environmentName);
  await deployProjects(environmentName);
};

const refreshDeployments = async (environmentName, projects) => {
  await createEnvironmentConfigMap(environmentName, projects);
  await deployProjects(environmentName);
};

const destroyEnvironment = async (environmentName) => {
  const helmDelete = new Job('helm-delete', 'jakubborys/ditc-brigade-worker:latest');
  helmDelete.storage.enabled = false;
  helmDelete.imageForcePull = true;
  helmDelete.tasks = [
    `helm delete \
    $(helm list --short | grep ${environmentName}) \
    --purge`,
  ];
  await helmDelete.run();
  const deleteOptions = new kubernetes.V1DeleteOptions();
  await k8sClient.deleteNamespace(environmentName, deleteOptions);
  await k8sClient.deleteNamespacedConfigMap(
    `environment-config-${environmentName}`, BRIGADE_NAMESPACE, deleteOptions,
  );
};

const logError = (error) => {
  console.log('ERROR');
  if (error.body) {
    // Errors coming from k8s client will have all
    // relevant info in the `body` field.
    console.log(error.body);
  } else {
    console.log(error);
  }
  throw error;
};

events.on('exec', (e) => {
  try {
    const payload = JSON.parse(e.payload);
    const { name, projects, action } = payload;

    if (!name) {
      throw Error('Environment name must be specified');
    }
    if (protectedEnvironment(name)) {
      throw Error(`Environment '${name}' is protected`);
    }

    switch (action) {
      case 'create':
        provisionEnvironment(name, projects).catch((error) => {
          logError(error);
        });
        break;
      case 'delete':
        destroyEnvironment(name).catch((error) => {
          logError(error);
        });
        break;
      case 'refresh':
        refreshDeployments(name, projects).catch((error) => {
          logError(error);
        });
        break;
      default:
        throw Error('Not a supported action');
    }
  } catch (error) {
    logError(error);
  }
});
