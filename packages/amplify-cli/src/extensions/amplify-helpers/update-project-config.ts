import { stateManager, $TSAny } from 'amplify-cli-core';

export function updateProjectConfig(projectPath: string | undefined, label: string, data: $TSAny) {
  const projectConfig = stateManager.getProjectConfig(projectPath, {
    throwIfNotExist: false,
    default: {},
  });

  projectConfig[label] = data;

  stateManager.setProjectConfig(projectPath, projectConfig);
}
