const en = {
  'office.reader.content': 'Content',
  'office.reader.preview': 'Page preview',
  'office.reader.section': 'Section',
  'office.reader.openOriginal': 'Open original',
  'office.reader.refresh': 'Refresh',
  'office.reader.find': 'Find in this section',
  'office.reader.rendering': 'Creating page preview…',
  'office.reader.loading': 'Reading document…',
  'office.reader.empty': 'No content in this range.',
  'office.reader.previous': 'Previous',
  'office.reader.next': 'Next',
  'office.reader.quote': 'Quote in the composer',
  'office.reader.cachedValue': 'Stored value; recalculation has not been verified',
  'office.reader.needsRecalculation': 'Needs recalculation',
  'office.reader.picture': 'Image',
  'office.reader.chart': 'Chart',
  'office.reader.sourceRequired': 'Select a conversation associated with this file source to read it here, or open the original file.',
} as const;
const localized: Record<string, string[]> = {
  'zh-CN': '内容|版面预览|章节|打开原文件|刷新|在当前章节中查找|正在生成版面预览…|正在读取文档…|此范围没有内容。|上一组|下一组|引用到输入框|保存的缓存值，尚未确认重新计算|待重新计算|图片|图表|选择关联此文件来源的会话后即可在此读取，也可以打开原文件。'.split('|'),
  'zh-TW': '內容|版面預覽|章節|開啟原始檔案|重新整理|在目前章節中尋找|正在產生版面預覽…|正在讀取文件…|此範圍沒有內容。|上一組|下一組|引用到輸入框|已儲存的快取值，尚未確認重新計算|待重新計算|圖片|圖表|選擇與此檔案來源相關的對話後即可在此讀取，也可以開啟原始檔案。'.split('|'),
  ja: '内容|ページプレビュー|セクション|元のファイルを開く|更新|このセクションで検索|プレビューを生成中…|文書を読み込み中…|この範囲には内容がありません。|前へ|次へ|入力欄に引用|保存された値。再計算は未確認|再計算が必要|画像|グラフ|このファイルのソースに関連付けられた会話を選択するか、元のファイルを開いてください。'.split('|'),
  ko: '내용|페이지 미리보기|섹션|원본 열기|새로 고침|현재 섹션에서 찾기|미리보기 생성 중…|문서 읽는 중…|이 범위에 내용이 없습니다.|이전|다음|입력창에 인용|저장된 값이며 재계산은 확인되지 않음|재계산 필요|이미지|차트|이 파일 원본과 연결된 대화를 선택하거나 원본 파일을 여세요.'.split('|'),
  fr: 'Contenu|Aperçu des pages|Section|Ouvrir l’original|Actualiser|Rechercher dans cette section|Création de l’aperçu…|Lecture du document…|Aucun contenu dans cette plage.|Précédent|Suivant|Citer dans le message|Valeur enregistrée ; recalcul non vérifié|Recalcul nécessaire|Image|Graphique|Sélectionnez une conversation liée à cette source ou ouvrez le fichier original.'.split('|'),
  es: 'Contenido|Vista previa|Sección|Abrir original|Actualizar|Buscar en esta sección|Creando vista previa…|Leyendo documento…|No hay contenido en este rango.|Anterior|Siguiente|Citar en el mensaje|Valor guardado; recálculo sin verificar|Necesita recálculo|Imagen|Gráfico|Selecciona una conversación vinculada a este origen o abre el archivo original.'.split('|'),
  'pt-BR': 'Conteúdo|Prévia das páginas|Seção|Abrir original|Atualizar|Buscar nesta seção|Criando prévia…|Lendo documento…|Nenhum conteúdo neste intervalo.|Anterior|Próximo|Citar na mensagem|Valor salvo; recálculo não verificado|Precisa recalcular|Imagem|Gráfico|Selecione uma conversa vinculada a esta origem ou abra o arquivo original.'.split('|'),
  pl: 'Treść|Podgląd stron|Sekcja|Otwórz oryginał|Odśwież|Szukaj w tej sekcji|Tworzenie podglądu…|Odczytywanie dokumentu…|Brak treści w tym zakresie.|Poprzednie|Następne|Zacytuj w wiadomości|Zapisana wartość; przeliczenie niezweryfikowane|Wymaga przeliczenia|Obraz|Wykres|Wybierz rozmowę powiązaną z tym źródłem lub otwórz oryginalny plik.'.split('|'),
  uk: 'Вміст|Перегляд сторінок|Розділ|Відкрити оригінал|Оновити|Знайти в цьому розділі|Створення перегляду…|Читання документа…|У цьому діапазоні немає вмісту.|Попередні|Наступні|Цитувати в повідомленні|Збережене значення; перерахунок не перевірено|Потрібен перерахунок|Зображення|Діаграма|Виберіть розмову, пов’язану з цим джерелом, або відкрийте оригінальний файл.'.split('|'),
};
export function officeReaderMessages(locale: string): Record<keyof typeof en, string> {
  return Object.fromEntries(Object.entries(en).map(([key, value], index) => [key, localized[locale]?.[index] ?? value])) as Record<keyof typeof en, string>;
}
