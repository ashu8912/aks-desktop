// Copyright (c) Microsoft Corporation.
// Licensed under the Apache 2.0.

import { useEffect, useState } from 'react';
import { getClusterCapabilities } from '../utils/azure/az-clusters';
import { getManagedNamespaceResourceId } from '../utils/azure/az-identity';

/** Appends a new error message, joining with '; ' if a previous error exists. */
function appendError(prev: string | null, next: string): string {
  return prev ? `${prev}; ${next}` : next;
}

/**
 * Fetches namespace capabilities (managed namespace status, Azure RBAC).
 * Return values: `undefined` = still loading or indeterminate, `true`/`false` = resolved.
 * For `isManagedNamespace`: only set to `true` on definitive success; `undefined` if the API
 * returns a non-success result (could be transient/auth issue); `false` only on thrown errors.
 * For `azureRbacEnabled`: `undefined` if the cluster capabilities are unavailable or not set.
 */
interface UseNamespaceCapabilitiesParams {
  subscriptionId: string | undefined;
  resourceGroup: string | undefined;
  clusterName: string | undefined;
  namespace: string;
}

export function useNamespaceCapabilities({
  subscriptionId,
  resourceGroup,
  clusterName,
  namespace,
}: UseNamespaceCapabilitiesParams) {
  const [isManagedNamespace, setIsManagedNamespace] = useState<boolean | undefined>(undefined);
  const [azureRbacEnabled, setAzureRbacEnabled] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!subscriptionId || !resourceGroup || !clusterName) return;
    let cancelled = false;

    setIsManagedNamespace(undefined);
    setAzureRbacEnabled(undefined);
    setError(null);

    getManagedNamespaceResourceId({
      clusterName,
      resourceGroup,
      namespaceName: namespace,
      subscriptionId,
    })
      .then(result => {
        if (!cancelled) {
          if (result.success) {
            // resourceId present → managed namespace; absent → regular namespace
            setIsManagedNamespace(!!result.resourceId);
          } else {
            setIsManagedNamespace(undefined);
            setError(prev =>
              appendError(prev, result.error ?? 'Failed to check managed namespace status')
            );
          }
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[useNamespaceCapabilities] Failed to check managed namespace:', err);
          setIsManagedNamespace(false);
          setError(prev =>
            appendError(
              prev,
              err instanceof Error ? err.message : 'Failed to check namespace capabilities'
            )
          );
        }
      });

    getClusterCapabilities({
      subscriptionId,
      resourceGroup,
      clusterName,
    })
      .then(caps => {
        if (!cancelled) setAzureRbacEnabled(caps?.azureRbacEnabled ?? undefined);
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[useNamespaceCapabilities] Failed to get cluster capabilities:', err);
          setAzureRbacEnabled(undefined);
          setError(prev =>
            appendError(
              prev,
              err instanceof Error ? err.message : 'Failed to get cluster capabilities'
            )
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [subscriptionId, resourceGroup, clusterName, namespace]);

  return { isManagedNamespace, azureRbacEnabled, error };
}
