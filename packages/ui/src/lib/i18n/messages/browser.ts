const en = {
  'browser.pageClosed': 'This page was closed.',
  'browser.back': 'Back',
  'browser.forward': 'Forward',
  'browser.userControl': 'You are controlling this page',
  'browser.agentWorking': 'Agent is using this page',
  'browser.resume': 'Allow Agent input',
  'browser.takeOver': 'Take over',
  'browser.openPage': 'Open this page',
  'browser.confirm': 'Confirm',
  'browser.cancel': 'Cancel',
  'browser.scriptPending': 'A page script is still pending; reload or close the page to stop it.',
};
const localized: Record<string, string[]> = {
  'zh-CN': '此页面已关闭。|后退|前进|你正在操作此页面|Agent 正在操作此页面|允许 Agent 继续|接手页面|打开此页面|确认|取消'.split('|'),
  'zh-TW': '此頁面已關閉。|上一頁|下一頁|你正在操作此頁面|Agent 正在操作此頁面|允許 Agent 繼續|接手頁面|開啟此頁面|確認|取消'.split('|'),
  ja: 'このページは閉じられました。|戻る|進む|このページを操作中|Agent がこのページを操作中|Agent の操作を許可|操作を引き継ぐ|このページを開く|確認|キャンセル'.split('|'),
  ko: '이 페이지가 닫혔습니다.|뒤로|앞으로|현재 페이지를 직접 조작 중|Agent가 페이지를 조작 중|Agent 입력 허용|직접 조작|이 페이지 열기|확인|취소'.split('|'),
  fr: 'Cette page a été fermée.|Retour|Suivant|Vous contrôlez cette page|L’Agent utilise cette page|Autoriser les actions de l’Agent|Prendre le contrôle|Ouvrir cette page|Confirmer|Annuler'.split('|'),
  es: 'Esta página se cerró.|Atrás|Adelante|Tienes el control de esta página|El Agent está usando esta página|Permitir acciones del Agent|Tomar el control|Abrir esta página|Confirmar|Cancelar'.split('|'),
  'pt-BR': 'Esta página foi fechada.|Voltar|Avançar|Você está controlando esta página|O Agent está usando esta página|Permitir ações do Agent|Assumir o controle|Abrir esta página|Confirmar|Cancelar'.split('|'),
  pl: 'Ta strona została zamknięta.|Wstecz|Dalej|Sterujesz tą stroną|Agent korzysta z tej strony|Zezwól Agentowi na działania|Przejmij sterowanie|Otwórz tę stronę|Potwierdź|Anuluj'.split('|'),
  uk: 'Цю сторінку закрито.|Назад|Вперед|Ви керуєте цією сторінкою|Agent працює з цією сторінкою|Дозволити дії Agent|Перейняти керування|Відкрити цю сторінку|Підтвердити|Скасувати'.split('|'),
};
export function browserMessages(locale: string): Record<keyof typeof en, string> {
  const pending: Record<string, string> = { 'zh-CN': '页面脚本尚未结束；可重载或关闭页面终止。', 'zh-TW': '頁面腳本尚未結束；可重新載入或關閉頁面終止。',
    ja: 'ページスクリプトは実行待ちです。再読み込みまたはページを閉じると終了します。', ko: '페이지 스크립트가 아직 대기 중입니다. 새로고침하거나 페이지를 닫아 중지할 수 있습니다.',
    fr: 'Un script reste en attente ; rechargez ou fermez la page pour l’arrêter.', es: 'Hay un script pendiente; recarga o cierra la página para detenerlo.',
    'pt-BR': 'Um script ainda está pendente; recarregue ou feche a página para interrompê-lo.', pl: 'Skrypt strony nadal oczekuje; odśwież lub zamknij stronę, aby go zatrzymać.',
    uk: 'Скрипт сторінки ще очікує; перезавантажте або закрийте сторінку, щоб зупинити його.' };
  return Object.fromEntries(Object.entries(en).map(([key, value], index) => [key, key === 'browser.scriptPending' ? pending[locale] ?? value : localized[locale]?.[index] ?? value])) as Record<keyof typeof en, string>;
}
