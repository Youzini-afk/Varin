/** Read original upload bytes; parsing and durable retention belong to the Host. */
export const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
  reader.onload = () => {
    const value = typeof reader.result === 'string' ? reader.result : '';
    const separator = value.indexOf(',');
    if (separator === -1) { reject(new Error(`Could not decode ${file.name}`)); return; }
    resolve(value.slice(separator + 1));
  };
  reader.readAsDataURL(file);
});
