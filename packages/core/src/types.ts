export interface AppIdentityPayloadV1 {
  version: 1;
  publisherPublicKey: string;
  app: {
    id: string;
    name: string;
  };
}

export interface AppIdentityProofV1 extends AppIdentityPayloadV1 {
  signature: string;
}

export interface KeymasterAppManifestV1 extends AppIdentityPayloadV1 {
  identitySignature: string;
  index: string;
  files: Record<string, string>;
  bundleSignature: string;
}

export type BundleSigningPayloadV1 = Omit<KeymasterAppManifestV1, "bundleSignature">;

export interface PublisherSigner {
  getPublicKey(): Promise<string>;
  signDigest(digest32: Uint8Array): Promise<Uint8Array>;
}

export interface DeploymentRecordV1 {
  version: 1;
  publisherPublicKey: string;
  appId: string;
  appName: string;
  indexHash: string;
  filesByHash: Record<
    string,
    {
      logicalPaths: string[];
      contentType: string;
    }
  >;
}

export interface VerifyDeploymentOptions {
  allowUnsigned?: boolean;
  entryLogicalPath?: string;
  strictFiles?: boolean;
  maxManifestBytes?: number;
  signal?: AbortSignal;
}

export interface BundleFileInput {
  logicalPath: string;
  bytes: Uint8Array;
}
