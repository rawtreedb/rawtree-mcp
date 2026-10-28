export interface S3StorageInput {
  data: { bucket: string; path?: string };
  backups: { bucket: string; path?: string };
  roleArn: string;
}

export function s3StorageRequestBody(s3Storage: S3StorageInput) {
  return {
    data: { bucket: s3Storage.data.bucket, path: s3Storage.data.path ?? '' },
    backups: {
      bucket: s3Storage.backups.bucket,
      path: s3Storage.backups.path ?? '',
    },
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
