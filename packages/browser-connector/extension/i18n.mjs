export const message = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);

export function localizeDocument() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = message(element.dataset.i18n);
  }
}
