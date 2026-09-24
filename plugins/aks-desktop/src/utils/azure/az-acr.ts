// Copyright (c) Microsoft Corporation.
// Licensed under the Apache 2.0.
// Azure Container Registry CLI functions.

import { debugLog, isValidGuid, needsRelogin, runAzCommand, runCommandAsync } from './az-cli-core';
import { isValidAzResourceName } from './az-validation';

/** Azure Container Registry name: 5-50 lowercase alphanumeric characters. */
export const ACR_NAME_PATTERN = /^[a-z0-9]{5,50}$/;

/** Shared validation error for invalid ACR names. */
export const ACR_NAME_ERROR = 'Registry name must be 5-50 lowercase alphanumeric characters.';

/**
 * Creates an Azure Container Registry.
 */
export async function createContainerRegistry(options: {
  registryName: string;
  resourceGroup: string;
  subscriptionId: string;
  location: string;
  sku?: 'Basic' | 'Standard' | 'Premium';
}): Promise<{ success: boolean; id?: string; loginServer?: string; error?: string }> {
  const { registryName, resourceGroup, subscriptionId, location, sku = 'Basic' } = options;

  if (!isValidGuid(subscriptionId)) {
    return { success: false, error: 'Invalid subscription ID format' };
  }
  if (!ACR_NAME_PATTERN.test(registryName)) {
    return {
      success: false,
      error: `Invalid registry name: ${ACR_NAME_ERROR}`,
    };
  }
  if (!isValidAzResourceName(resourceGroup)) {
    return { success: false, error: 'Invalid resource group name format' };
  }

  const result = await runAzCommand(
    [
      'acr',
      'create',
      '--name',
      registryName,
      '--resource-group',
      resourceGroup,
      '--sku',
      sku,
      '--location',
      location,
      '--subscription',
      subscriptionId,
      '--output',
      'json',
    ],
    'Creating container registry:',
    'create container registry',
    (stdout: string) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        throw new Error(
          `Unexpected output from ACR create command: ${e instanceof Error ? e.message : e}`
        );
      }
      return {
        id: parsed.id as string,
        loginServer: parsed.loginServer as string,
      };
    }
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    id: result.data?.id,
    loginServer: result.data?.loginServer,
  };
}

// Azure Container Registry functions (moved from az-cli.ts)
export type AcrSku = 'Basic' | 'Standard' | 'Premium';

export interface AcrInfo {
  id: string;
  name: string;
  resourceGroup: string;
  loginServer: string;
  location: string;
  sku: AcrSku;
}

export async function getContainerRegistries(subscriptionId: string): Promise<AcrInfo[]> {
  if (!isValidGuid(subscriptionId)) {
    throw new Error('Invalid subscription ID format');
  }

  const result = await runAzCommand<AcrInfo[]>(
    ['acr', 'list', '--subscription', subscriptionId, '--output', 'json'],
    'Listing container registries:',
    'list container registries',
    (stdout: string) => {
      const registries = JSON.parse(stdout || '[]') as any[];
      return registries.map(
        (r): AcrInfo => ({
          id: r.id,
          name: r.name,
          resourceGroup: r.resourceGroup,
          loginServer: r.loginServer,
          location: r.location,
          sku: r.sku?.name ?? r.sku ?? 'Basic',
        })
      );
    }
  );

  if (!result.success) {
    throw new Error(result.error ?? 'Failed to get container registries');
  }
  return result.data!;
}

export async function getContainerImages(
  subscriptionId: string,
  registryName?: string
): Promise<any[]> {
  let allImages: any[] = [];

  if (registryName) {
    // Get images from specific registry
    const images = await getImagesFromRegistry(subscriptionId, registryName);
    allImages = allImages.concat(images);
  } else {
    // Get all registries first, then get images from each
    const registries = await getContainerRegistries(subscriptionId);

    for (const registry of registries) {
      try {
        const images = await getImagesFromRegistry(subscriptionId, registry.name);
        allImages = allImages.concat(images);
      } catch (error) {
        console.warn(`Failed to get images from registry ${registry.name}:`, error);
        // Continue with other registries
      }
    }
  }

  return allImages;
}

async function getImagesFromRegistry(subscriptionId: string, registryName: string): Promise<any[]> {
  // First get list of repositories
  const { stdout: repoStdout, stderr: repoStderr } = await runCommandAsync('az', [
    'acr',
    'repository',
    'list',
    '--name',
    registryName,
    '--subscription',
    subscriptionId,
    '--output',
    'json',
  ]);

  if (repoStderr && needsRelogin(repoStderr)) {
    throw new Error('Authentication required. Please log in to Azure CLI: az login');
  }

  if (repoStderr && (repoStderr.includes('ERROR') || repoStderr.includes('error'))) {
    console.error(`Failed to get repositories from ${registryName}:`, repoStderr);
    return [];
  }

  let repositories: string[] = [];
  try {
    repositories = JSON.parse(repoStdout || '[]');
  } catch (error) {
    console.error('Failed to parse repositories response:', error);
    return [];
  }

  const allImages: any[] = [];
  const MAX_REPOSITORIES = 10; // Limit to first 10 repositories for performance
  const MAX_IMAGES_TOTAL = 50; // Stop after collecting 50 images total

  // Limit repositories for performance
  const limitedRepositories = repositories.slice(0, MAX_REPOSITORIES);

  // Get images from each repository
  for (const repository of limitedRepositories) {
    try {
      // Early termination if we have enough images
      if (allImages.length >= MAX_IMAGES_TOTAL) {
        debugLog(`Limiting results to ${MAX_IMAGES_TOTAL} images for performance`);
        break;
      }

      const { stdout: tagStdout, stderr: tagStderr } = await runCommandAsync('az', [
        'acr',
        'repository',
        'show-tags',
        '--name',
        registryName,
        '--repository',
        repository,
        '--subscription',
        subscriptionId,
        '--output',
        'json',
        '--orderby',
        'time_desc',
        '--top',
        '5', // Reduced to 5 most recent tags per repository for performance
      ]);

      if (tagStderr && tagStderr.includes('ERROR')) {
        console.warn(`Failed to get tags for ${repository}:`, tagStderr);
        continue;
      }

      const tags = JSON.parse(tagStdout || '[]');

      for (const tag of tags) {
        // Skip expensive manifest call for better performance
        // Use basic info only - users can see size/details after deployment
        allImages.push({
          id: `${registryName}/${repository}:${tag}`,
          name: repository.split('/').pop() || repository,
          repository,
          tag,
          registry: `${registryName}.azurecr.io`,
          registryName,
          createdTime: new Date().toISOString().split('T')[0], // Use current date as fallback
          size: 'Unknown', // Skip size lookup for performance
          digest: '',
        });

        // Early termination check within tag loop
        if (allImages.length >= MAX_IMAGES_TOTAL) {
          break;
        }
      }
    } catch (error) {
      console.warn(`Failed to process repository ${repository}:`, error);
    }
  }

  return allImages;
}
