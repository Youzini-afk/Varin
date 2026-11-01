import { normalizeLocale, type Locale } from '@varin/application-client/locale';
import type { MenuItemConstructorOptions } from 'electron';

// Small native-shell catalog. English source strings are keys; the renderer's
// large dictionaries and React dependencies never enter the main process.
const translatedLocales = ['zh-CN', 'zh-TW', 'fr', 'es', 'pt-BR', 'uk', 'ko', 'pl', 'ja'] as const;
type Translations = readonly [string, string, string, string, string, string, string, string, string];
const messages = {
  'About Varin': ['关于 Varin', '關於 Varin', 'À propos de Varin', 'Acerca de Varin', 'Sobre o Varin', 'Про Varin', 'Varin 정보', 'O Varin', 'Varin について'],
  'Check for Updates': ['检查更新', '檢查更新', 'Rechercher des mises à jour', 'Buscar actualizaciones', 'Verificar atualizações', 'Перевірити оновлення', '업데이트 확인', 'Sprawdź aktualizacje', 'アップデートを確認'],
  'Settings': ['设置', '設定', 'Paramètres', 'Configuración', 'Configurações', 'Налаштування', '설정', 'Ustawienia', '設定'],
  'Command Palette': ['命令面板', '命令面板', 'Palette de commandes', 'Paleta de comandos', 'Paleta de comandos', 'Палітра команд', '명령 팔레트', 'Paleta poleceń', 'コマンドパレット'],
  'File': ['文件', '檔案', 'Fichier', 'Archivo', 'Arquivo', 'Файл', '파일', 'Plik', 'ファイル'],
  'New Window': ['新建窗口', '新增視窗', 'Nouvelle fenêtre', 'Nueva ventana', 'Nova janela', 'Нове вікно', '새 창', 'Nowe okno', '新しいウィンドウ'],
  'New Session': ['新建会话', '新增對話', 'Nouvelle conversation', 'Nueva conversación', 'Nova conversa', 'Нова розмова', '새 대화', 'Nowa rozmowa', '新しい会話'],
  'New Worktree': ['新建独立工作区', '新增獨立工作區', 'Nouvel espace de travail isolé', 'Nuevo espacio de trabajo aislado', 'Novo espaço de trabalho isolado', 'Новий ізольований робочий простір', '새 독립 작업 공간', 'Nowa odizolowana przestrzeń robocza', '新しい独立ワークスペース'],
  'Add Workspace': ['添加工作区', '新增工作區', 'Ajouter un espace de travail', 'Añadir espacio de trabajo', 'Adicionar espaço de trabalho', 'Додати робочий простір', '작업 공간 추가', 'Dodaj przestrzeń roboczą', 'ワークスペースを追加'],
  'Edit': ['编辑', '編輯', 'Édition', 'Editar', 'Editar', 'Редагування', '편집', 'Edycja', '編集'],
  'Undo': ['撤销', '復原', 'Annuler', 'Deshacer', 'Desfazer', 'Скасувати дію', '실행 취소', 'Cofnij', '元に戻す'],
  'Redo': ['重做', '重做', 'Rétablir', 'Rehacer', 'Refazer', 'Повторити дію', '다시 실행', 'Ponów', 'やり直す'],
  'Cut': ['剪切', '剪下', 'Couper', 'Cortar', 'Recortar', 'Вирізати', '잘라내기', 'Wytnij', '切り取り'],
  'Copy': ['复制', '複製', 'Copier', 'Copiar', 'Copiar', 'Копіювати', '복사', 'Kopiuj', 'コピー'],
  'Paste': ['粘贴', '貼上', 'Coller', 'Pegar', 'Colar', 'Вставити', '붙여넣기', 'Wklej', '貼り付け'],
  'Paste and Match Style': ['粘贴并匹配样式', '貼上並符合樣式', 'Coller et adapter le style', 'Pegar con el mismo estilo', 'Colar e combinar estilo', 'Вставити з відповідним стилем', '스타일에 맞춰 붙여넣기', 'Wklej i dopasuj styl', 'スタイルを合わせて貼り付け'],
  'Select All': ['全选', '全選', 'Tout sélectionner', 'Seleccionar todo', 'Selecionar tudo', 'Вибрати все', '모두 선택', 'Zaznacz wszystko', 'すべて選択'],
  'Add Selection to Chat': ['将所选内容添加到聊天', '將所選內容加入聊天', 'Ajouter la sélection à la conversation', 'Añadir selección al chat', 'Adicionar seleção à conversa', 'Додати виділене до чату', '선택 항목을 대화에 추가', 'Dodaj zaznaczenie do rozmowy', '選択範囲をチャットに追加'],
  'View': ['视图', '顯示', 'Affichage', 'Ver', 'Exibir', 'Вигляд', '보기', 'Widok', '表示'],
  'Toggle Right Sidebar': ['显示/隐藏右侧栏', '顯示／隱藏右側欄', 'Afficher/masquer le panneau droit', 'Mostrar/ocultar panel derecho', 'Mostrar/ocultar painel direito', 'Показати/сховати праву панель', '오른쪽 사이드바 표시/숨기기', 'Pokaż/ukryj prawy panel', '右サイドバーを切り替え'],
  'Open Git Sidebar': ['打开 Git 侧栏', '開啟 Git 側欄', 'Ouvrir le panneau Git', 'Abrir panel de Git', 'Abrir painel Git', 'Відкрити панель Git', 'Git 사이드바 열기', 'Otwórz panel Git', 'Git サイドバーを開く'],
  'Search Workspace': ['搜索工作区', '搜尋工作區', 'Rechercher dans cet espace de travail', 'Buscar en el espacio de trabajo', 'Pesquisar no espaço de trabalho', 'Пошук у робочому просторі', '작업 공간 검색', 'Szukaj w przestrzeni roboczej', 'ワークスペースを検索'],
  'Toggle Terminal Dock': ['显示/隐藏终端', '顯示／隱藏終端機', 'Afficher/masquer le terminal', 'Mostrar/ocultar terminal', 'Mostrar/ocultar terminal', 'Показати/сховати термінал', '터미널 표시/숨기기', 'Pokaż/ukryj terminal', 'ターミナルを切り替え'],
  'Toggle Terminal Expanded': ['展开/收起终端', '展開／收合終端機', 'Agrandir/réduire le terminal', 'Expandir/contraer terminal', 'Expandir/recolher terminal', 'Розгорнути/згорнути термінал', '터미널 확장/축소', 'Rozwiń/zwiń terminal', 'ターミナルの展開を切り替え'],
  'Light Theme': ['亮色主题', '淺色主題', 'Thème clair', 'Tema claro', 'Tema claro', 'Світла тема', '밝은 테마', 'Jasny motyw', 'ライトテーマ'],
  'Dark Theme': ['暗色主题', '深色主題', 'Thème sombre', 'Tema oscuro', 'Tema escuro', 'Темна тема', '어두운 테마', 'Ciemny motyw', 'ダークテーマ'],
  'System Theme': ['跟随系统主题', '跟隨系統主題', 'Thème du système', 'Tema del sistema', 'Tema do sistema', 'Системна тема', '시스템 테마', 'Motyw systemowy', 'システムテーマ'],
  'Toggle Session Sidebar': ['显示/隐藏会话侧栏', '顯示／隱藏對話側欄', 'Afficher/masquer les conversations', 'Mostrar/ocultar conversaciones', 'Mostrar/ocultar conversas', 'Показати/сховати панель розмов', '대화 사이드바 표시/숨기기', 'Pokaż/ukryj panel rozmów', '会話サイドバーを切り替え'],
  'Toggle Full Screen': ['切换全屏', '切換全螢幕', 'Basculer en plein écran', 'Alternar pantalla completa', 'Alternar tela cheia', 'Перемкнути повноекранний режим', '전체 화면 전환', 'Przełącz pełny ekran', 'フルスクリーンを切り替え'],
  'Window': ['窗口', '視窗', 'Fenêtre', 'Ventana', 'Janela', 'Вікно', '창', 'Okno', 'ウィンドウ'],
  'Minimize': ['最小化', '最小化', 'Réduire', 'Minimizar', 'Minimizar', 'Згорнути', '최소화', 'Minimalizuj', '最小化'],
  'Zoom': ['缩放窗口', '縮放視窗', 'Agrandir', 'Ampliar', 'Ampliar', 'Масштабувати вікно', '창 확대', 'Powiększ', '拡大／縮小'],
  'Close': ['关闭', '關閉', 'Fermer', 'Cerrar', 'Fechar', 'Закрити', '닫기', 'Zamknij', '閉じる'],
  'Help': ['帮助', '說明', 'Aide', 'Ayuda', 'Ajuda', 'Довідка', '도움말', 'Pomoc', 'ヘルプ'],
  'Keyboard Shortcuts': ['快捷键', '鍵盤快速鍵', 'Raccourcis clavier', 'Atajos de teclado', 'Atalhos de teclado', 'Клавіатурні скорочення', '키보드 단축키', 'Skróty klawiaturowe', 'キーボードショートカット'],
  'Show Diagnostics': ['显示诊断信息', '顯示診斷資訊', 'Afficher les diagnostics', 'Mostrar diagnósticos', 'Mostrar diagnósticos', 'Показати діагностику', '진단 정보 표시', 'Pokaż diagnostykę', '診断情報を表示'],
  'Toggle Developer Tools': ['切换开发者工具', '切換開發者工具', 'Afficher/masquer les outils de développement', 'Alternar herramientas de desarrollo', 'Alternar ferramentas de desenvolvimento', 'Перемкнути інструменти розробника', '개발자 도구 전환', 'Przełącz narzędzia programistyczne', '開発者ツールを切り替え'],
  'Clear Cache': ['清除缓存', '清除快取', 'Vider le cache', 'Borrar caché', 'Limpar cache', 'Очистити кеш', '캐시 지우기', 'Wyczyść pamięć podręczną', 'キャッシュを消去'],
  'Report a Bug': ['报告问题', '回報問題', 'Signaler un problème', 'Informar de un problema', 'Relatar um problema', 'Повідомити про помилку', '문제 신고', 'Zgłoś błąd', '不具合を報告'],
  'Request a Feature': ['提出功能建议', '提出功能建議', 'Proposer une fonctionnalité', 'Sugerir una función', 'Sugerir um recurso', 'Запропонувати функцію', '기능 제안', 'Zaproponuj funkcję', '機能を提案'],
  'Join Discord': ['加入 Discord', '加入 Discord', 'Rejoindre Discord', 'Unirse a Discord', 'Entrar no Discord', 'Приєднатися до Discord', 'Discord 참여', 'Dołącz do Discorda', 'Discord に参加'],
  'Reload Webview': ['重新加载页面', '重新載入頁面', 'Recharger la page', 'Recargar página', 'Recarregar página', 'Перезавантажити сторінку', '페이지 새로고침', 'Odśwież stronę', 'ページを再読み込み'],
  'Restart': ['重启', '重新啟動', 'Redémarrer', 'Reiniciar', 'Reiniciar', 'Перезапустити', '다시 시작', 'Uruchom ponownie', '再起動'],
  'Reload': ['重新加载', '重新載入', 'Recharger', 'Recargar', 'Recarregar', 'Перезавантажити', '새로고침', 'Odśwież', '再読み込み'],
  'Force Reload': ['强制重新加载', '強制重新載入', 'Forcer le rechargement', 'Forzar recarga', 'Forçar recarga', 'Примусово перезавантажити', '강제 새로고침', 'Wymuś odświeżenie', '強制再読み込み'],
  'Go': ['前往', '前往', 'Aller', 'Ir', 'Ir', 'Перехід', '이동', 'Przejdź', '移動'],
  'Back': ['后退', '返回', 'Retour', 'Atrás', 'Voltar', 'Назад', '뒤로', 'Wstecz', '戻る'],
  'Forward': ['前进', '前進', 'Suivant', 'Adelante', 'Avançar', 'Вперед', '앞으로', 'Dalej', '進む'],
  'Previous Session': ['上一个会话', '上一個對話', 'Conversation précédente', 'Conversación anterior', 'Conversa anterior', 'Попередня розмова', '이전 대화', 'Poprzednia rozmowa', '前の会話'],
  'Next Session': ['下一个会话', '下一個對話', 'Conversation suivante', 'Siguiente conversación', 'Próxima conversa', 'Наступна розмова', '다음 대화', 'Następna rozmowa', '次の会話'],
  'Previous Project': ['上一个项目', '上一個專案', 'Projet précédent', 'Proyecto anterior', 'Projeto anterior', 'Попередній проєкт', '이전 프로젝트', 'Poprzedni projekt', '前のプロジェクト'],
  'Next Project': ['下一个项目', '下一個專案', 'Projet suivant', 'Siguiente proyecto', 'Próximo projeto', 'Наступний проєкт', '다음 프로젝트', 'Następny projekt', '次のプロジェクト'],
  'Services': ['服务', '服務', 'Services', 'Servicios', 'Serviços', 'Служби', '서비스', 'Usługi', 'サービス'],
  'Hide Varin': ['隐藏 Varin', '隱藏 Varin', 'Masquer Varin', 'Ocultar Varin', 'Ocultar Varin', 'Сховати Varin', 'Varin 숨기기', 'Ukryj Varin', 'Varin を隠す'],
  'Hide Others': ['隐藏其他应用', '隱藏其他 App', 'Masquer les autres', 'Ocultar los demás', 'Ocultar outros', 'Сховати інші', '다른 앱 숨기기', 'Ukryj inne', 'ほかを隠す'],
  'Show All': ['全部显示', '全部顯示', 'Tout afficher', 'Mostrar todo', 'Mostrar tudo', 'Показати все', '모두 표시', 'Pokaż wszystkie', 'すべて表示'],
  'Quit Varin': ['退出 Varin', '結束 Varin', 'Quitter Varin', 'Salir de Varin', 'Sair do Varin', 'Вийти з Varin', 'Varin 종료', 'Zakończ Varin', 'Varin を終了'],
  'Learn Spelling': ['记住拼写', '記住拼字', 'Mémoriser cette orthographe', 'Aprender palabra', 'Aprender ortografia', 'Запам’ятати написання', '맞춤법 학습', 'Zapamiętaj pisownię', 'スペルを登録'],
  'Look Up “{selection}”': ['查询“{selection}”', '查詢「{selection}」', 'Rechercher « {selection} »', 'Consultar «{selection}»', 'Consultar “{selection}”', 'Знайти «{selection}»', '“{selection}” 찾아보기', 'Sprawdź „{selection}”', '「{selection}」を調べる'],
  'Search with Google': ['使用 Google 搜索', '使用 Google 搜尋', 'Rechercher avec Google', 'Buscar con Google', 'Pesquisar com o Google', 'Шукати в Google', 'Google로 검색', 'Szukaj w Google', 'Google で検索'],
  'No Guesses Found': ['没有拼写建议', '沒有拼字建議', 'Aucune suggestion', 'No hay sugerencias', 'Nenhuma sugestão', 'Немає пропозицій', '추천 단어 없음', 'Brak sugestii', '候補が見つかりません'],
  'Save Image': ['保存图片', '儲存圖片', 'Enregistrer l’image', 'Guardar imagen', 'Salvar imagem', 'Зберегти зображення', '이미지 저장', 'Zapisz obraz', '画像を保存'],
  'Save Image As…': ['图片另存为…', '另存圖片為…', 'Enregistrer l’image sous…', 'Guardar imagen como…', 'Salvar imagem como…', 'Зберегти зображення як…', '이미지를 다른 이름으로 저장…', 'Zapisz obraz jako…', '名前を付けて画像を保存…'],
  'Save Video': ['保存视频', '儲存影片', 'Enregistrer la vidéo', 'Guardar vídeo', 'Salvar vídeo', 'Зберегти відео', '동영상 저장', 'Zapisz wideo', '動画を保存'],
  'Save Video As…': ['视频另存为…', '另存影片為…', 'Enregistrer la vidéo sous…', 'Guardar vídeo como…', 'Salvar vídeo como…', 'Зберегти відео як…', '동영상을 다른 이름으로 저장…', 'Zapisz wideo jako…', '名前を付けて動画を保存…'],
  'Copy Link': ['复制链接', '複製連結', 'Copier le lien', 'Copiar enlace', 'Copiar link', 'Копіювати посилання', '링크 복사', 'Kopiuj link', 'リンクをコピー'],
  'Save Link As…': ['链接另存为…', '另存連結為…', 'Enregistrer le lien sous…', 'Guardar enlace como…', 'Salvar link como…', 'Зберегти посилання як…', '링크를 다른 이름으로 저장…', 'Zapisz link jako…', '名前を付けてリンクを保存…'],
  'Copy Image': ['复制图片', '複製圖片', 'Copier l’image', 'Copiar imagen', 'Copiar imagem', 'Копіювати зображення', '이미지 복사', 'Kopiuj obraz', '画像をコピー'],
  'Copy Image Address': ['复制图片地址', '複製圖片網址', 'Copier l’adresse de l’image', 'Copiar dirección de imagen', 'Copiar endereço da imagem', 'Копіювати адресу зображення', '이미지 주소 복사', 'Kopiuj adres obrazu', '画像のアドレスをコピー'],
  'Copy Video Address': ['复制视频地址', '複製影片網址', 'Copier l’adresse de la vidéo', 'Copiar dirección del vídeo', 'Copiar endereço do vídeo', 'Копіювати адресу відео', '동영상 주소 복사', 'Kopiuj adres wideo', '動画のアドレスをコピー'],
  'Copy Video Frame': ['复制视频帧', '複製影片影格', 'Copier l’image vidéo', 'Copiar fotograma', 'Copiar quadro do vídeo', 'Копіювати кадр відео', '동영상 프레임 복사', 'Kopiuj klatkę wideo', '動画のフレームをコピー'],
  'Save Video Frame As…': ['视频帧另存为…', '另存影片影格為…', 'Enregistrer l’image vidéo sous…', 'Guardar fotograma como…', 'Salvar quadro do vídeo como…', 'Зберегти кадр відео як…', '동영상 프레임을 다른 이름으로 저장…', 'Zapisz klatkę wideo jako…', '名前を付けてフレームを保存…'],
  'Picture in Picture': ['画中画', '子母畫面', 'Image dans l’image', 'Imagen en imagen', 'Picture-in-picture', 'Картинка в картинці', '화면 속 화면', 'Obraz w obrazie', 'ピクチャ・イン・ピクチャ'],
  'Inspect Element': ['检查元素', '檢查元素', 'Inspecter l’élément', 'Inspeccionar elemento', 'Inspecionar elemento', 'Дослідити елемент', '요소 검사', 'Zbadaj element', '要素を検証'],
  'Open Varin': ['打开 Varin', '開啟 Varin', 'Ouvrir Varin', 'Abrir Varin', 'Abrir Varin', 'Відкрити Varin', 'Varin 열기', 'Otwórz Varin', 'Varin を開く'],
  'Show Varin': ['显示 Varin', '顯示 Varin', 'Afficher Varin', 'Mostrar Varin', 'Mostrar Varin', 'Показати Varin', 'Varin 표시', 'Pokaż Varin', 'Varin を表示'],
  'Show Window': ['显示窗口', '顯示視窗', 'Afficher la fenêtre', 'Mostrar ventana', 'Mostrar janela', 'Показати вікно', '창 표시', 'Pokaż okno', 'ウィンドウを表示'],
  'Hide Window': ['隐藏窗口', '隱藏視窗', 'Masquer la fenêtre', 'Ocultar ventana', 'Ocultar janela', 'Сховати вікно', '창 숨기기', 'Ukryj okno', 'ウィンドウを隠す'],
  'Mode: Local': ['模式：本地', '模式：本機', 'Mode : local', 'Modo: local', 'Modo: local', 'Режим: локальний', '모드: 로컬', 'Tryb: lokalny', 'モード：ローカル'],
  'Mode: Remote ({mode})': ['模式：远程（{mode}）', '模式：遠端（{mode}）', 'Mode : distant ({mode})', 'Modo: remoto ({mode})', 'Modo: remoto ({mode})', 'Режим: віддалений ({mode})', '모드: 원격 ({mode})', 'Tryb: zdalny ({mode})', 'モード：リモート（{mode}）'],
  'Untitled session': ['未命名会话', '未命名對話', 'Conversation sans titre', 'Conversación sin título', 'Conversa sem título', 'Розмова без назви', '제목 없는 대화', 'Rozmowa bez tytułu', '無題の会話'],
  'Session': ['会话', '對話', 'Conversation', 'Conversación', 'Conversa', 'Розмова', '대화', 'Rozmowa', '会話'],
  'Sessions': ['会话', '對話', 'Conversations', 'Conversaciones', 'Conversas', 'Розмови', '대화', 'Rozmowy', '会話'],
  'Permission request': ['权限请求', '權限請求', 'Demande d’autorisation', 'Solicitud de permiso', 'Pedido de permissão', 'Запит дозволу', '권한 요청', 'Prośba o uprawnienia', '権限のリクエスト'],
  'Question': ['提问', '提問', 'Question', 'Pregunta', 'Pergunta', 'Запитання', '질문', 'Pytanie', '質問'],
  'Needs your attention': ['需要你处理', '需要你處理', 'Votre attention est requise', 'Requiere tu atención', 'Precisa da sua atenção', 'Потребує вашої уваги', '확인이 필요합니다', 'Wymaga Twojej uwagi', '確認が必要です'],
  '{count} more…': ['另外 {count} 项…', '另外 {count} 項…', '{count} de plus…', '{count} más…', 'Mais {count}…', 'Ще {count}…', '{count}개 더…', 'Jeszcze {count}…', 'ほか {count} 件…'],
  'No active sessions': ['没有活动会话', '沒有進行中的對話', 'Aucune conversation active', 'No hay conversaciones activas', 'Nenhuma conversa ativa', 'Немає активних розмов', '활성 대화 없음', 'Brak aktywnych rozmów', '進行中の会話はありません'],
  '{count} awaiting approval': ['{count} 项等待批准', '{count} 項等待核准', '{count} en attente d’approbation', '{count} pendientes de aprobación', '{count} aguardando aprovação', '{count} очікують схвалення', '{count}개 승인 대기', '{count} oczekuje na zatwierdzenie', '{count} 件が承認待ち'],
  '{count} with errors': ['{count} 项出错', '{count} 項發生錯誤', '{count} en erreur', '{count} con errores', '{count} com erros', '{count} з помилками', '{count}개 오류', '{count} z błędami', '{count} 件のエラー'],
  '{count} working': ['{count} 项执行中', '{count} 項執行中', '{count} en cours', '{count} en curso', '{count} em andamento', '{count} у роботі', '{count}개 작업 중', '{count} w toku', '{count} 件を実行中'],
  '{count} unread': ['{count} 条未读', '{count} 則未讀', '{count} non lus', '{count} sin leer', '{count} não lidos', '{count} непрочитаних', '{count}개 읽지 않음', '{count} nieprzeczytanych', '{count} 件の未読'],
  '{count} session': ['{count} 个会话', '{count} 個對話', '{count} conversation', '{count} conversación', '{count} conversa', 'Розмов: {count}', '대화 {count}개', 'Rozmowy: {count}', '{count} 件の会話'],
  '{count} sessions': ['{count} 个会话', '{count} 個對話', '{count} conversations', '{count} conversaciones', '{count} conversas', 'Розмов: {count}', '대화 {count}개', 'Rozmowy: {count}', '{count} 件の会話'],
  'Idle': ['空闲', '閒置', 'Inactif', 'Inactivo', 'Ocioso', 'Бездіяльність', '대기 중', 'Bezczynny', '待機中'],
  'Varin is using this computer': ['Varin 正在使用这台电脑', 'Varin 正在使用這台電腦', 'Varin utilise cet ordinateur', 'Varin está usando este equipo', 'Varin está usando este computador', 'Varin використовує цей комп’ютер', 'Varin이 이 컴퓨터를 사용 중입니다', 'Varin korzysta z tego komputera', 'Varin がこのコンピューターを操作中'],
  'You are using this computer': ['你正在使用这台电脑', '你正在使用這台電腦', 'Vous utilisez cet ordinateur', 'Estás usando este equipo', 'Você está usando este computador', 'Ви використовуєте цей комп’ютер', '컴퓨터를 직접 사용 중입니다', 'Korzystasz z tego komputera', 'あなたがこのコンピューターを操作中'],
  'Take over': ['我来接手', '由我接手', 'Prendre le contrôle', 'Tomar el control', 'Assumir controle', 'Перебрати керування', '직접 제어', 'Przejmij kontrolę', '操作を引き継ぐ'],
  'Hand back to Varin': ['交还给 Varin', '交還給 Varin', 'Rendre le contrôle à Varin', 'Devolver el control a Varin', 'Devolver controle ao Varin', 'Повернути керування Varin', 'Varin에 제어 반환', 'Oddaj kontrolę Varin', 'Varin に操作を戻す'],
  'Cancel computer work': ['取消电脑操作', '取消電腦操作', 'Annuler les actions sur l’ordinateur', 'Cancelar acciones en el equipo', 'Cancelar ações no computador', 'Скасувати дії на комп’ютері', '컴퓨터 작업 취소', 'Anuluj pracę na komputerze', 'コンピューター操作を中止'],
  'Transferring control…': ['正在交接控制…', '正在交接控制…', 'Transfert du contrôle…', 'Transfiriendo control…', 'Transferindo controle…', 'Передавання керування…', '제어 전환 중…', 'Przekazywanie kontroli…', '操作を引き継ぎ中…'],
  'Cancelling…': ['正在取消…', '正在取消…', 'Annulation…', 'Cancelando…', 'Cancelando…', 'Скасування…', '취소 중…', 'Anulowanie…', '中止中…'],
  'Input release is unconfirmed': ['输入释放尚未确认', '輸入釋放尚未確認', 'La libération des entrées n’est pas confirmée', 'No se ha confirmado la liberación de entrada', 'Liberação de entrada não confirmada', 'Звільнення вводу не підтверджено', '입력 해제가 확인되지 않았습니다', 'Zwolnienie wejścia niepotwierdzone', '入力の解放は未確認です'],
  'Varin Computer controls': ['Varin 电脑控制', 'Varin 電腦控制', 'Contrôle de l’ordinateur Varin', 'Control del equipo de Varin', 'Controles do computador Varin', 'Керування комп’ютером Varin', 'Varin 컴퓨터 제어', 'Sterowanie komputerem Varin', 'Varin コンピューター操作'],
  'Varin Computer feedback': ['Varin 电脑操作反馈', 'Varin 電腦操作回饋', 'Retour des actions Varin', 'Indicadores de control de Varin', 'Indicadores de controle do Varin', 'Індикація дій Varin', 'Varin 컴퓨터 작업 표시', 'Wskaźniki operacji Varin', 'Varin 操作フィードバック'],
  'Varin Companion': ['Varin 桌宠', 'Varin 桌面夥伴', 'Compagnon Varin', 'Compañero Varin', 'Companheiro Varin', 'Компаньйон Varin', 'Varin 데스크톱 친구', 'Towarzysz Varin', 'Varin デスクトップコンパニオン'],
  'Varin Mini Chat': ['Varin 迷你聊天', 'Varin 迷你聊天', 'Mini-chat Varin', 'Mini chat de Varin', 'Mini chat Varin', 'Мінічат Varin', 'Varin 미니 채팅', 'Miniczat Varin', 'Varin ミニチャット'],
  'Quit Varin?': ['退出 Varin？', '結束 Varin？', 'Quitter Varin ?', '¿Salir de Varin?', 'Sair do Varin?', 'Вийти з Varin?', 'Varin을 종료할까요?', 'Zakończyć Varin?', 'Varin を終了しますか？'],
  'Quit': ['退出', '結束', 'Quitter', 'Salir', 'Sair', 'Вийти', '종료', 'Zakończ', '終了'],
  'Cancel': ['取消', '取消', 'Annuler', 'Cancelar', 'Cancelar', 'Скасувати', '취소', 'Anuluj', 'キャンセル'],
  'Quitting will stop background processes and may interrupt pending work.': ['退出将停止后台进程，并可能中断尚未完成的工作。', '結束將停止背景處理程序，並可能中斷尚未完成的工作。', 'Quitter arrêtera les processus en arrière-plan et peut interrompre le travail en attente.', 'Salir detendrá los procesos en segundo plano y podría interrumpir el trabajo pendiente.', 'Sair encerrará processos em segundo plano e poderá interromper trabalhos pendentes.', 'Вихід зупинить фонові процеси й може перервати незавершену роботу.', '종료하면 백그라운드 프로세스가 중지되고 진행 중인 작업이 중단될 수 있습니다.', 'Zamknięcie zatrzyma procesy w tle i może przerwać oczekujące zadania.', '終了するとバックグラウンド処理が停止し、未完了の作業が中断される場合があります。'],
  'Background processes (sidecar, SSH sessions) will be stopped.': ['后台进程（服务、SSH 会话）将停止。', '背景處理程序（服務、SSH 工作階段）將停止。', 'Les processus en arrière-plan (service, sessions SSH) seront arrêtés.', 'Se detendrán los procesos en segundo plano (servicio, sesiones SSH).', 'Os processos em segundo plano (serviço, sessões SSH) serão encerrados.', 'Фонові процеси (служба, сеанси SSH) буде зупинено.', '백그라운드 프로세스(서비스, SSH 세션)가 중지됩니다.', 'Procesy w tle (usługa, sesje SSH) zostaną zatrzymane.', 'バックグラウンド処理（サービス、SSH セッション）が停止します。'],
  'Active tunnel': ['有活动隧道', '有使用中的通道', 'Tunnel actif', 'Túnel activo', 'Túnel ativo', 'Активний тунель', '활성 터널', 'Aktywny tunel', '有効なトンネル'],
  'Running scheduled tasks: {count}': ['执行中的定时任务：{count}', '執行中的排程工作：{count}', 'Tâches planifiées en cours : {count}', 'Tareas programadas en ejecución: {count}', 'Tarefas agendadas em execução: {count}', 'Запланованих завдань у роботі: {count}', '실행 중인 예약 작업: {count}', 'Uruchomione zaplanowane zadania: {count}', '実行中の予約タスク：{count}'],
  'Enabled scheduled tasks: {count}': ['已启用的定时任务：{count}', '已啟用的排程工作：{count}', 'Tâches planifiées activées : {count}', 'Tareas programadas activadas: {count}', 'Tarefas agendadas ativadas: {count}', 'Увімкнених запланованих завдань: {count}', '활성화된 예약 작업: {count}', 'Włączone zaplanowane zadania: {count}', '有効な予約タスク：{count}'],
  'Connect to Varin server?': ['连接到 Varin 服务器？', '連線至 Varin 伺服器？', 'Se connecter au serveur Varin ?', '¿Conectar al servidor de Varin?', 'Conectar ao servidor Varin?', 'Підключитися до сервера Varin?', 'Varin 서버에 연결할까요?', 'Połączyć z serwerem Varin?', 'Varin サーバーに接続しますか？'],
  'Connect to “{label}”?': ['连接到“{label}”？', '連線至「{label}」？', 'Se connecter à « {label} » ?', '¿Conectar a «{label}»?', 'Conectar a “{label}”?', 'Підключитися до «{label}»?', '“{label}”에 연결할까요?', 'Połączyć z „{label}”?', '「{label}」に接続しますか？'],
  'This will add {url} as a remote instance and route this app’s activity through it. Only continue if you trust this server and started the connection yourself.': ['这会将 {url} 添加为远程实例，并通过它处理应用活动。仅当你信任该服务器且主动发起了此次连接时才继续。', '這會將 {url} 加入為遠端執行個體，並透過它處理應用程式活動。只有在你信任該伺服器且主動發起此次連線時才繼續。', 'Le serveur {url} sera ajouté comme instance distante et traitera l’activité de cette application. Continuez uniquement si vous lui faites confiance et avez lancé cette connexion.', 'Se añadirá {url} como instancia remota y se dirigirá la actividad de esta aplicación a través de ella. Continúa solo si confías en este servidor e iniciaste la conexión.', 'Isso adicionará {url} como instância remota e encaminhará a atividade do aplicativo por ela. Continue apenas se confiar no servidor e tiver iniciado a conexão.', 'Сервер {url} буде додано як віддалений екземпляр, через який проходитиме робота застосунку. Продовжуйте, лише якщо довіряєте серверу та самі ініціювали підключення.', '{url}을 원격 인스턴스로 추가하고 이 앱의 활동을 해당 서버를 통해 처리합니다. 서버를 신뢰하며 직접 연결을 시작한 경우에만 계속하세요.', 'Serwer {url} zostanie dodany jako zdalna instancja i będzie obsługiwać działania aplikacji. Kontynuuj tylko, jeśli ufasz temu serwerowi i samodzielnie rozpoczęto połączenie.', '{url} をリモートインスタンスとして追加し、アプリの処理をこのサーバー経由で行います。信頼するサーバーで、ご自身が開始した接続の場合のみ続行してください。'],
  'Connect': ['连接', '連線', 'Se connecter', 'Conectar', 'Conectar', 'Підключитися', '연결', 'Połącz', '接続'],
  'Files': ['文件', '檔案', 'Fichiers', 'Archivos', 'Arquivos', 'Файли', '파일', 'Pliki', 'ファイル'],
  'Open File': ['打开文件', '開啟檔案', 'Ouvrir un fichier', 'Abrir archivo', 'Abrir arquivo', 'Відкрити файл', '파일 열기', 'Otwórz plik', 'ファイルを開く'],
  'Select Folder': ['选择文件夹', '選擇資料夾', 'Choisir un dossier', 'Seleccionar carpeta', 'Selecionar pasta', 'Вибрати теку', '폴더 선택', 'Wybierz folder', 'フォルダーを選択'],
  'Open': ['打开', '開啟', 'Ouvrir', 'Abrir', 'Abrir', 'Відкрити', '열기', 'Otwórz', '開く'],
  'Save': ['保存', '儲存', 'Enregistrer', 'Guardar', 'Salvar', 'Зберегти', '저장', 'Zapisz', '保存'],
  'Save Markdown': ['保存 Markdown 文件', '儲存 Markdown 檔案', 'Enregistrer le Markdown', 'Guardar Markdown', 'Salvar Markdown', 'Зберегти Markdown', 'Markdown 저장', 'Zapisz Markdown', 'Markdown を保存'],
} as const satisfies Record<string, Translations>;

export type NativeMessage = keyof typeof messages;
let locale: Locale = 'en';
export const getNativeLocale = (): Locale => locale;
export const setNativeLocale = (value: string): void => { locale = normalizeLocale(value); };
export const nativeText = (key: NativeMessage, params?: Record<string, string | number>): string => {
  const index = translatedLocales.findIndex(candidate => candidate === locale);
  const template = index < 0 ? key : messages[key][index]!;
  return params ? template.replace(/\{([^{}]+)\}/g, (match, name: string) => params[name] === undefined ? match : String(params[name])) : template;
};

const roleMessages = {
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteAndMatchStyle: 'Paste and Match Style', selectAll: 'Select All',
  services: 'Services', hide: 'Hide Varin', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit Varin', close: 'Close',
  minimize: 'Minimize', zoom: 'Zoom', reload: 'Reload', forceReload: 'Force Reload', togglefullscreen: 'Toggle Full Screen',
} as const satisfies Partial<Record<NonNullable<MenuItemConstructorOptions['role']>, NativeMessage>>;

// Only for templates owned by Varin: user titles and content must not be
// translated by matching their text. Explicit labels keep native roles and
// their OS behavior while following the application's language.
export const localizeNativeMenu = (template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => template.map(item => {
  const key = item.label && Object.hasOwn(messages, item.label) ? item.label as NativeMessage
    : !item.label && item.role ? roleMessages[item.role as keyof typeof roleMessages] : undefined;
  return { ...item, ...(key ? { label: nativeText(key) } : {}),
    ...(Array.isArray(item.submenu) ? { submenu: localizeNativeMenu(item.submenu) } : {}) };
});

const contextMessages = {
  learnSpelling: 'Learn Spelling', lookUpSelection: 'Look Up “{selection}”', searchWithGoogle: 'Search with Google', dictionarySuggestions: 'No Guesses Found',
  cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteAndMatchStyle: 'Paste and Match Style', selectAll: 'Select All',
  saveImage: 'Save Image', saveImageAs: 'Save Image As…', saveVideo: 'Save Video', saveVideoAs: 'Save Video As…',
  copyLink: 'Copy Link', saveLinkAs: 'Save Link As…', copyImage: 'Copy Image', copyImageAddress: 'Copy Image Address',
  copyVideoAddress: 'Copy Video Address', copyVideoFrame: 'Copy Video Frame', saveVideoFrameAs: 'Save Video Frame As…',
  pictureInPicture: 'Picture in Picture', inspect: 'Inspect Element', services: 'Services',
} as const satisfies Record<string, NativeMessage>;

// electron-context-menu reads labels on each invocation. Getters pick up the
// current locale without reinstalling handlers on every WebContents.
export const nativeContextMenuLabels = Object.defineProperties({}, Object.fromEntries(
  Object.entries(contextMessages).map(([id, key]) => [id, { enumerable: true, get: () => nativeText(key) }]),
)) as Record<keyof typeof contextMessages, string>;
