import _ from 'lodash';
import {
  $TSAny,
  $TSContext,
  $TSObject,
  AmplifyCategories,
  AmplifySupportedService,
  CLIInputSchemaValidator,
  exitOnNextTick,
  JSONUtilities,
  pathManager,
} from 'amplify-cli-core';
import { printer } from 'amplify-prompts';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  GroupAccessType,
  S3AccessType,
  S3PermissionType,
  S3TriggerEventType,
  S3TriggerPrefixType,
  S3UserInputs,
  S3UserInputTriggerFunctionParams,
} from '../service-walkthrough-types/s3-user-input-types';
import { migrateAuthDependencyResource } from './s3-auth-api';
import { buildShortUUID } from './s3-walkthrough';

export interface MigrationParams {
  parametersFilepath: string;
  cfnFilepath: string;
  storageParamsFilepath: string;
  parameters: $TSObject;
  cfn: $TSObject;
  storageParams: $TSObject;
}

export enum S3CFNPermissionType {
  CREATE = 's3:PutObject',
  READ = 's3:GetObject',
  DELETE = 's3:DeleteObject',
  LIST = 's3:ListBucket',
}

export enum S3StorageParamsPermissionType {
  CREATE_AND_UPDATE = 'create/update',
  READ = 'read',
  DELETE = 'delete',
}

export interface S3CFNPermissionMapType {
  [S3StorageParamsPermissionType.CREATE_AND_UPDATE]: S3CFNPermissionType[];
  [S3StorageParamsPermissionType.READ]: S3CFNPermissionType[];
  [S3StorageParamsPermissionType.DELETE]: S3CFNPermissionType[];
}

//use this to capture input
interface IObjectS3PermissionType {
  [key: string]: S3PermissionType[];
}
export interface S3PermissionMapType extends IObjectS3PermissionType {
  'create/update': S3PermissionType[];
  read: S3PermissionType[];
  delete: S3PermissionType[];
}

export type S3CFNDependsOn = {
  category: string;
  resourceName: string;
  attributes: string[];
};

export type GroupCFNAccessType = Record<string, S3CFNPermissionType[]>;

export type GroupStorageParamsAccessType = Record<string, S3StorageParamsPermissionType[]>;

//Data generated by amplify which should not be overridden by the user
export type S3FeatureMetadata = {
  dependsOn: S3CFNDependsOn[];
};

export type S3InputStateOptions = {
  resourceName: string;
  inputPayload?: S3UserInputs;
  metadata?: S3FeatureMetadata;
};

/**
 *
 * @param resourceName - Name of S3 resource
 * @returns true  - if resource can be transformed (its cli-inputs file has been generated)
 *          false - otherwise
 */
export function canResourceBeTransformed(context: $TSContext, resourceName: string): boolean {
  const resourceInputState = new S3InputState(context, resourceName, undefined);
  return resourceInputState.cliInputFileExists();
}

export class S3InputState {
  static s3InputState: S3InputState;
  _cliInputsFilePath: string; //cli-inputs.json (output) filepath
  _resourceName: string; //user friendly name provided by user
  _category: string; //category of the resource
  _service: string; //AWS service for the resource
  _inputPayload: S3UserInputs | undefined; //S3 options selected by user
  buildFilePath: string;

  constructor(private readonly context: $TSContext, resourceName: string, userInput: S3UserInputs | undefined) {
    this._category = AmplifyCategories.STORAGE;
    this._service = AmplifySupportedService.S3;
    const projectBackendDirPath = pathManager.getBackendDirPath();
    this._cliInputsFilePath = path.resolve(path.join(projectBackendDirPath, AmplifyCategories.STORAGE, resourceName, 'cli-inputs.json'));
    this._resourceName = resourceName;
    this.buildFilePath = path.resolve(path.join(projectBackendDirPath, AmplifyCategories.STORAGE, resourceName, 'build'));
    if (userInput) {
      //Add flow
      this._inputPayload = userInput;
    } else {
      if (this.cliInputFileExists()) {
        this._inputPayload = this.getCliInputPayload(); //Update flow
      } else {
        return; //Migration flow
      }
    }
    //validate CLI inputs
    this.isCLIInputsValid(this._inputPayload);
  }

  getOldS3ParamsForMigration(): MigrationParams {
    const backendDir = pathManager.getBackendDirPath();
    const oldParametersFilepath = path.join(backendDir, AmplifyCategories.STORAGE, this._resourceName, 'parameters.json');
    const oldCFNFilepath = path.join(backendDir, AmplifyCategories.STORAGE, this._resourceName, 's3-cloudformation-template.json');
    const oldStorageParamsFilepath = path.join(backendDir, AmplifyCategories.STORAGE, this._resourceName, `storage-params.json`);
    const oldParameters = JSONUtilities.readJson<$TSAny>(oldParametersFilepath, { throwIfNotExist: true });
    const oldCFN = JSONUtilities.readJson<$TSAny>(oldCFNFilepath, { throwIfNotExist: true });
    const oldStorageParams = JSONUtilities.readJson<$TSAny>(oldStorageParamsFilepath, { throwIfNotExist: false }) || {};
    const oldParams: MigrationParams = {
      parametersFilepath: oldParametersFilepath,
      cfnFilepath: oldCFNFilepath,
      storageParamsFilepath: oldStorageParamsFilepath,
      parameters: oldParameters,
      cfn: oldCFN,
      storageParams: oldStorageParams,
    };
    return oldParams;
  }

  inferAuthPermissions(oldParams: $TSAny): $TSAny[] {
    if (
      oldParams.selectedAuthenticatedPermissions &&
      ((oldParams.s3PermissionsAuthenticatedPublic && oldParams.s3PermissionsAuthenticatedPublic != 'DISALLOW') ||
        (oldParams.s3PermissionsAuthenticatedPrivate && oldParams.s3PermissionsAuthenticatedPrivate != 'DISALLOW') ||
        (oldParams.s3PermissionsAuthenticatedProtected && oldParams.s3PermissionsAuthenticatedProtected != 'DISALLOW') ||
        (oldParams.s3PermissionsAuthenticatedUploads && oldParams.s3PermissionsAuthenticatedUploads != 'DISALLOW'))
    ) {
      return oldParams.selectedAuthenticatedPermissions;
    } else {
      return [];
    }
  }
  inferGuestPermissions(oldParams: $TSAny): $TSAny[] {
    if (
      oldParams.selectedGuestPermissions &&
      ((oldParams.s3PermissionsGuestPublic && oldParams.s3PermissionsGuestPublic != 'DISALLOW') ||
        (oldParams.s3PermissionsGuestPrivate && oldParams.s3PermissionsGuestPrivate != 'DISALLOW') ||
        (oldParams.s3PermissionsGuestProtected && oldParams.s3PermissionsGuestProtected != 'DISALLOW') ||
        (oldParams.s3PermissionsGuestUploads && oldParams.s3PermissionsGuestUploads != 'DISALLOW'))
    ) {
      return oldParams.selectedGuestPermissions;
    } else {
      return [];
    }
  }

  genInputParametersForMigration(oldS3Params: MigrationParams): S3UserInputs {
    const oldParams = oldS3Params.parameters;
    const storageParams = oldS3Params.storageParams;
    const userInputs: S3UserInputs = {
      resourceName: this._resourceName,
      bucketName: oldParams.bucketName,
      policyUUID: buildShortUUID(), //Since UUID is unique for every resource, we re-create the policy names with new UUID.
      storageAccess: S3AccessType.AUTH_ONLY,
      guestAccess: [],
      authAccess: [],
      triggerFunction: 'NONE',
      groupAccess: undefined,
    };
    const authPermissions = this.inferAuthPermissions(oldParams);
    const guestPermissions = this.inferGuestPermissions(oldParams);

    if (oldParams.triggerFunction) {
      userInputs.triggerFunction = oldParams.triggerFunction;
    }
    if (authPermissions && authPermissions.length > 0) {
      userInputs.authAccess = S3InputState.getInputPermissionsFromCfnPermissions(authPermissions);
    } else {
      userInputs.authAccess = [];
    }
    if (guestPermissions && guestPermissions.length > 0) {
      userInputs.guestAccess = S3InputState.getInputPermissionsFromCfnPermissions(guestPermissions);
    } else {
      userInputs.guestAccess = [];
    }

    if (userInputs.guestAccess?.length > 0) {
      userInputs.storageAccess = S3AccessType.AUTH_AND_GUEST;
    } else {
      if (userInputs.authAccess?.length > 0) {
        userInputs.storageAccess = S3AccessType.AUTH_ONLY;
      }
    }

    if (storageParams && Object.prototype.hasOwnProperty.call(storageParams, 'groupPermissionMap')) {
      userInputs.groupAccess = S3InputState.getPolicyMapFromStorageParamPolicyMap(storageParams.groupPermissionMap);
    }

    return userInputs;
  }

  removeOldS3ConfigFiles(migrationParams: MigrationParams) {
    // Remove old files
    if (fs.existsSync(migrationParams.cfnFilepath)) {
      fs.removeSync(migrationParams.cfnFilepath);
    }
    if (fs.existsSync(migrationParams.parametersFilepath)) {
      fs.removeSync(migrationParams.parametersFilepath);
    }
    if (fs.existsSync(migrationParams.storageParamsFilepath)) {
      fs.removeSync(migrationParams.storageParamsFilepath);
    }
  }

  public checkNeedsMigration(): boolean {
    const backendDir = pathManager.getBackendDirPath();
    const oldParametersFilepath = path.join(backendDir, AmplifyCategories.STORAGE, this._resourceName, 'parameters.json');
    const oldCFNFilepath = path.join(backendDir, AmplifyCategories.STORAGE, this._resourceName, 's3-cloudformation-template.json');
    return fs.existsSync(oldParametersFilepath) && fs.existsSync(oldCFNFilepath);
  }

  public async migrate(context: $TSContext) {
    //check if migration is possible
    if (!this.checkNeedsMigration()) {
      return;
    }
    try {
      const authMigrationAccepted = await migrateAuthDependencyResource(context);
      if (!authMigrationAccepted) {
        exitOnNextTick(0);
      }
    } catch (error) {
      printer.error(`Migration for Auth resource failed with error : ${error as string}`);
      throw error;
    }
    const oldS3Params: MigrationParams = this.getOldS3ParamsForMigration();
    const cliInputs: S3UserInputs = this.genInputParametersForMigration(oldS3Params);
    await this.saveCliInputPayload(cliInputs);
    this.removeOldS3ConfigFiles(oldS3Params);
  }

  public cliInputFileExists(): boolean {
    return fs.existsSync(this._cliInputsFilePath);
  }

  checkPrefixExists(triggerPrefixList: S3TriggerPrefixType[], prefix: string) {
    for (const triggerPrefix of triggerPrefixList) {
      if (triggerPrefix.prefix === prefix) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if there exists a different trigger function configured on the prefix.
   * @param triggerFunctionName
   * @param triggerPrefixList
   * @returns true if there is no other trigger configured on this prefix. throws error if prefix used by another function
   */
  private _confirmLambdaTriggerPrefixUnique(triggerFunctionName: string, triggerPrefixList: S3TriggerPrefixType[]): boolean {
    if (this._inputPayload?.additionalTriggerFunctions) {
      for (const triggerParams of this._inputPayload.additionalTriggerFunctions) {
        if (triggerParams.triggerPrefix) {
          for (const configuredTriggerPrefix of triggerParams.triggerPrefix) {
            if (
              this.checkPrefixExists(triggerPrefixList, configuredTriggerPrefix.prefix) &&
              triggerParams.triggerFunction !== triggerFunctionName
            ) {
              throw new Error(
                `Error installing additional Lambda Trigger : trigger ${triggerParams.triggerFunction} already configured on prefix ${triggerParams.triggerPrefix}`,
              );
            }
          }
        }
      }
    }
    return true;
  }

  /**
   * Add a lambda trigger for Predictions category.
   * @param adminLambdaTrigger
   */
  public addAdminLambdaTrigger(adminLambdaTrigger: S3UserInputTriggerFunctionParams) {
    if (this._inputPayload) {
      this._inputPayload.adminTriggerFunction = adminLambdaTrigger;
    } else {
      throw new Error('Error : Admin Lambda Trigger cannot be installed because S3 recource CLI Input is not initialized.');
    }
  }

  public removeAdminLambdaTrigger() {
    if (this._inputPayload) {
      this._inputPayload.adminTriggerFunction = undefined;
    } else {
      throw new Error('Error : Admin Lambda Trigger cannot be installed because S3 recource CLI Input is not initialized.');
    }
  }

  /**
   * Insert the triggerfunction on the S3 bucket for the given prefix.
   * Throws error if a different trigger function is already configured on the given prefix.
   * used by categories like Predictions
   * @param triggerFunctionParams
   */
  public addAdditionalLambdaTrigger(triggerFunctionParams: S3UserInputTriggerFunctionParams) {
    let additionalTriggerFunctions: S3UserInputTriggerFunctionParams[] | undefined = [];
    if (!this._inputPayload) {
      throw new Error(`Error installing additional Lambda Trigger : Storage resource ${this._resourceName} not configured`);
    }
    if (triggerFunctionParams.triggerPrefix) {
      this._confirmLambdaTriggerPrefixUnique(triggerFunctionParams.triggerFunction, triggerFunctionParams.triggerPrefix);
    }
    if ((this._inputPayload as S3UserInputs).additionalTriggerFunctions) {
      let functionExists = false;
      const existingTriggerFunctions = (this._inputPayload as S3UserInputs).additionalTriggerFunctions;
      additionalTriggerFunctions = existingTriggerFunctions?.map(functionParams => {
        if (
          functionParams.triggerPrefix === triggerFunctionParams.triggerPrefix &&
          functionParams.triggerFunction === triggerFunctionParams.triggerFunction
        ) {
          //update trigger function
          functionExists = true;
          return triggerFunctionParams;
        } else {
          return functionParams;
        }
      });
      if (functionExists == false && additionalTriggerFunctions && additionalTriggerFunctions.length > 0) {
        additionalTriggerFunctions.push(triggerFunctionParams);
      }
    } else {
      additionalTriggerFunctions = [triggerFunctionParams];
    }
    (this._inputPayload as S3UserInputs).additionalTriggerFunctions = additionalTriggerFunctions;
  }

  public getUserInput() {
    // Read Cli Inputs file if exists
    if (this._inputPayload) {
      return this._inputPayload;
    } else {
      try {
        this._inputPayload = this.getCliInputPayload();
      } catch (e) {
        throw new Error('cli-inputs.json file missing from the resource directory');
      }
    }
    return this._inputPayload;
  }

  public async isCLIInputsValid(cliInputs?: S3UserInputs): Promise<boolean> {
    if (!cliInputs) {
      cliInputs = this.getCliInputPayload();
    }
    const schemaValidator = new CLIInputSchemaValidator(this.context, this._service, this._category, 'S3UserInputs');
    return await schemaValidator.validateInput(JSON.stringify(cliInputs));
  }

  public static getPermissionTypeFromCfnType(s3CFNPermissionType: S3CFNPermissionType): S3PermissionType {
    switch (s3CFNPermissionType) {
      case S3CFNPermissionType.CREATE:
        return S3PermissionType.CREATE_AND_UPDATE;
      case S3CFNPermissionType.READ:
      case S3CFNPermissionType.LIST:
        return S3PermissionType.READ;
      case S3CFNPermissionType.DELETE:
        return S3PermissionType.DELETE;
      default:
        throw new Error(`Unknown CFN Type: ${s3CFNPermissionType}`);
    }
  }

  public static getPermissionTypeFromStorageParamsType(s3StorageParamsPermissionType: S3StorageParamsPermissionType): S3PermissionType {
    switch (s3StorageParamsPermissionType) {
      case S3StorageParamsPermissionType.CREATE_AND_UPDATE:
        return S3PermissionType.CREATE_AND_UPDATE;
      case S3StorageParamsPermissionType.READ:
        return S3PermissionType.READ;
      case S3StorageParamsPermissionType.DELETE:
        return S3PermissionType.DELETE;
      default:
        throw new Error(`Unknown Storage Param Type: ${s3StorageParamsPermissionType}`);
    }
  }

  //S3CFNPermissionType
  public static getCfnTypesFromPermissionType(s3PermissionType: S3PermissionType): Array<S3CFNPermissionType> {
    switch (s3PermissionType) {
      case S3PermissionType.CREATE_AND_UPDATE:
        return [S3CFNPermissionType.CREATE];
      case S3PermissionType.READ:
        return [S3CFNPermissionType.READ, S3CFNPermissionType.LIST];
      case S3PermissionType.DELETE:
        return [S3CFNPermissionType.DELETE];
      default:
        throw new Error(`Unknown Permission Type: ${s3PermissionType}`);
    }
  }

  public static getInputPermissionsFromCfnPermissions(selectedGuestPermissions: S3CFNPermissionType[] | undefined) {
    if (selectedGuestPermissions && selectedGuestPermissions.length > 0) {
      const inputParams = selectedGuestPermissions.map(S3InputState.getPermissionTypeFromCfnType);
      return _.uniq(inputParams) as Array<S3PermissionType>; //required to remove List and Read mapping to the same entity
    } else {
      return [];
    }
  }

  public static getInputPermissionsFromStorageParamPermissions(storageParamGroupPermissions: S3StorageParamsPermissionType[] | undefined) {
    if (storageParamGroupPermissions && storageParamGroupPermissions.length > 0) {
      return storageParamGroupPermissions.map(S3InputState.getPermissionTypeFromStorageParamsType);
    } else {
      return [];
    }
  }

  public static getTriggerLambdaPermissionsFromInputPermission(triggerPermissions: S3PermissionType) {
    switch (triggerPermissions) {
      case S3PermissionType.CREATE_AND_UPDATE: //PUT, POST, and COPY
        return S3TriggerEventType.OBJ_PUT_POST_COPY;
      case S3PermissionType.DELETE:
        return S3TriggerEventType.OBJ_REMOVED;
    }
    throw new Error(`Unkown Trigger Lambda Permission Type ${triggerPermissions}`);
  }

  public static getCfnPermissionsFromInputPermissions(selectedPermissions: S3PermissionType[] | undefined) {
    if (selectedPermissions && selectedPermissions.length > 0) {
      let selectedCfnPermissions: S3CFNPermissionType[] = []; //S3CFNPermissionType
      for (const selectedPermission of selectedPermissions) {
        selectedCfnPermissions = selectedCfnPermissions.concat(S3InputState.getCfnTypesFromPermissionType(selectedPermission));
      }
      return selectedCfnPermissions;
    } else {
      return [];
    }
  }

  public static getPolicyMapFromCfnPolicyMap(groupCFNPolicyMap: GroupCFNAccessType) {
    if (groupCFNPolicyMap) {
      const result: GroupAccessType = {};
      for (const groupName of Object.keys(groupCFNPolicyMap)) {
        result[groupName] = S3InputState.getInputPermissionsFromCfnPermissions(groupCFNPolicyMap[groupName]);
      }
      return result;
    } else {
      return undefined;
    }
  }

  public static getPolicyMapFromStorageParamPolicyMap(
    groupStorageParamsPolicyMap: GroupStorageParamsAccessType,
  ): GroupAccessType | undefined {
    if (groupStorageParamsPolicyMap) {
      const result: GroupAccessType = {};
      for (const groupName of Object.keys(groupStorageParamsPolicyMap)) {
        result[groupName] = S3InputState.getInputPermissionsFromStorageParamPermissions(groupStorageParamsPolicyMap[groupName]);
      }
      return result;
    } else {
      return undefined;
    }
  }

  public static getPolicyMapFromStorageParamsPolicyMap(groupStorageParamsPolicyMap: GroupStorageParamsAccessType) {
    if (groupStorageParamsPolicyMap) {
      const result: GroupAccessType = {};
      for (const groupName of Object.keys(groupStorageParamsPolicyMap)) {
        result[groupName] = S3InputState.getInputPermissionsFromStorageParamPermissions(groupStorageParamsPolicyMap[groupName]);
      }
      return result;
    } else {
      return undefined;
    }
  }

  updateInputPayload(props: S3InputStateOptions) {
    // Overwrite
    this._inputPayload = props.inputPayload;

    // validate cli-inputs.json
    const schemaValidator = new CLIInputSchemaValidator(this.context, this._service, this._category, 'S3UserInputs');
    schemaValidator.validateInput(JSON.stringify(this._inputPayload!));
  }

  public static getInstance(context: $TSContext, props: S3InputStateOptions): S3InputState {
    if (!S3InputState.s3InputState) {
      S3InputState.s3InputState = new S3InputState(context, props.resourceName, props.inputPayload);
    }
    //update flow
    if (props.inputPayload) {
      S3InputState.s3InputState.updateInputPayload(props);
    }
    return S3InputState.s3InputState;
  }

  public getCliInputPayload(): S3UserInputs {
    let cliInputs: S3UserInputs;
    // Read cliInputs file if exists
    try {
      cliInputs = JSONUtilities.readJson<S3UserInputs>(this._cliInputsFilePath)!;
    } catch (e) {
      throw new Error('cli-inputs.json file missing from the resource directory');
    }
    return cliInputs;
  }

  public getCliMetadata(): S3FeatureMetadata | undefined {
    return undefined;
  }

  public async saveCliInputPayload(cliInputs: S3UserInputs): Promise<void> {
    await this.isCLIInputsValid(cliInputs);
    this._inputPayload = cliInputs;

    fs.ensureDirSync(path.join(pathManager.getBackendDirPath(), this._category, this._resourceName));

    JSONUtilities.writeJson(this._cliInputsFilePath, cliInputs);
  }
}
