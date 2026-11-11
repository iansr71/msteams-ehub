/** Parameter keys of the Azure Bot "Aadv2" OAuth provider, found in its provider listing. */
export function findProviderParameters(json: unknown): {
  readonly tenant: string | undefined;
  readonly exchange: string | undefined;
};
