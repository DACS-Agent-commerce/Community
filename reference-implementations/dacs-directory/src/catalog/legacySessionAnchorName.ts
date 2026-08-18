/**
 * Historical SDK-MVP program names used only while reading explicitly
 * labelled legacy bundles. These strings are not a current normative SDK API.
 */
export const legacySessionAnchorName = {
  agreement: (jobId: string): string => `dacs3:agreement:${jobId}`,
  evidence: (jobId: string): string => `dacs4:evidence:${jobId}`,
  vet: (jobId: string): string => `dacs2:verifyrecord:${jobId}`,
};
