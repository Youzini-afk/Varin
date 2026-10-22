export const getMultiRunSessionTitle = (parts: {
  groupSlug: string;
  runGroup?: string;
  providerID: string;
  modelID: string;
  index?: number;
}): string => {
  const segments = [encodeURIComponent(parts.groupSlug)];
  if (parts.runGroup) segments.push(parts.runGroup);
  segments.push(encodeURIComponent(parts.providerID), encodeURIComponent(parts.modelID));
  if (parts.index !== undefined) segments.push(String(parts.index));
  return segments.join('/');
};
