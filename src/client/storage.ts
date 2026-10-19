export interface S3StorageInput {
  dataBucket: string;
  dataPath?: string;
  backupBucket: string;
  backupPath?: string;
  roleArn: string;
}

export function s3StorageRequestBody(s3Storage: S3StorageInput) {
  return {
    data_bucket: s3Storage.dataBucket,
    data_path: s3Storage.dataPath ?? '',
    backup_bucket: s3Storage.backupBucket,
    backup_path: s3Storage.backupPath ?? '',
    role_arn: s3Storage.roleArn,
  };
}

export interface S3StorageAccessInput {
  externalId?: string;
  resourceTag?: string;
}

export function s3StorageAccessRequestBody(access: S3StorageAccessInput) {
  return {
    ...(access.externalId === undefined
      ? {}
      : { external_id: access.externalId }),
    ...(access.resourceTag === undefined
      ? {}
      : { resource_tag: access.resourceTag }),
  };
}
