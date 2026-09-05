/**
 * User-facing strings for the AI (Axiom) panel UI, localized to the 7 supported
 * UI locales. This covers ONLY what the user reads on screen — the usage meter,
 * model picker, status messages, and login/delete controls. Prompts, tool
 * names, and anything sent to the model are intentionally NOT localized.
 *
 * Dynamic AI strings previously had no localization (and one stray mixed
 * "AI Used量"); this gives them parity with the rest of the app.
 */

import { getUiLocale, type UiLocale } from "./i18n.js";

type Entry = Record<UiLocale, string>;

const STRINGS: Record<string, Entry> = {
  // ── Usage words (settings › Account) ──
  usage_tokens: { en: "tokens", ja: "トークン", zh: "tokens", ko: "토큰", fr: "jetons", de: "Tokens", es: "tokens" },

  // ── Model picker ──
  model_efficient: { en: "Fast and efficient", ja: "高速・低コスト", zh: "快速高效", ko: "빠르고 효율적", fr: "Rapide et efficace", de: "Schnell und effizient", es: "Rápido y eficiente" },
  model_autonomous: { en: "Advanced autonomous writing", ja: "高度な自律執筆", zh: "高级自主写作", ko: "고급 자율 글쓰기", fr: "Rédaction autonome avancée", de: "Fortgeschrittenes autonomes Schreiben", es: "Redacción autónoma avanzada" },
  model_requires_pro: { en: "Requires Pro plan", ja: "Proプランが必要", zh: "需要 Pro 套餐", ko: "Pro 플랜 필요", fr: "Nécessite le plan Pro", de: "Erfordert Pro-Plan", es: "Requiere plan Pro" },
  upsell_title: { en: "Available on the Pro plan", ja: "Pro プランで使えます", zh: "Pro 套餐可用", ko: "Pro 플랜에서 사용 가능", fr: "Disponible avec le plan Pro", de: "Im Pro-Plan verfügbar", es: "Disponible en el plan Pro" },
  see_pro_plans: { en: "See Pro plans", ja: "Proプランを見る", zh: "查看 Pro 套餐", ko: "Pro 플랜 보기", fr: "Voir les plans Pro", de: "Pro-Pläne ansehen", es: "Ver planes Pro" },

  // ── Status messages ──
  status_quota_reached: { en: "You've reached your monthly token limit.", ja: "今月のトークン上限に達しました。", zh: "您已达到本月的 token 上限。", ko: "이번 달 토큰 한도에 도달했습니다.", fr: "Vous avez atteint votre limite de jetons mensuelle.", de: "Sie haben Ihr monatliches Token-Limit erreicht.", es: "Has alcanzado tu límite de tokens del mes." },
  status_next_reset: { en: "Next reset", ja: "次回リセット", zh: "下次重置", ko: "다음 초기화", fr: "Prochaine réinitialisation", de: "Nächster Reset", es: "Próximo reinicio" },
  status_see_plan: { en: "See plan", ja: "プランを見る", zh: "查看套餐", ko: "플랜 보기", fr: "Voir le plan", de: "Plan ansehen", es: "Ver plan" },
  status_plan_check: { en: "Check your plan or contract status.", ja: "プラン/契約状況を確認してください。", zh: "请检查您的套餐或合约状态。", ko: "플랜 또는 계약 상태를 확인하세요.", fr: "Vérifiez votre plan ou l'état de votre contrat.", de: "Prüfen Sie Ihren Plan- oder Vertragsstatus.", es: "Revisa tu plan o el estado del contrato." },
  status_unavailable: { en: "Axiom is not available.", ja: "Axiom は利用できません。", zh: "Axiom 当前不可用。", ko: "Axiom을 사용할 수 없습니다.", fr: "Axiom n'est pas disponible.", de: "Axiom ist nicht verfügbar.", es: "Axiom no está disponible." },
  login_processing: { en: "Signing in with Google…", ja: "Googleでログイン中…", zh: "正在使用 Google 登录…", ko: "Google로 로그인 중…", fr: "Connexion avec Google…", de: "Anmeldung mit Google…", es: "Iniciando sesión con Google…" },

  // ── Login / overlay ──
  login: { en: "Login", ja: "ログイン", zh: "登录", ko: "로그인", fr: "Connexion", de: "Anmelden", es: "Entrar" },
  login_with_google: { en: "Log in with Google", ja: "Googleでログイン", zh: "使用 Google 登录", ko: "Google로 로그인", fr: "Se connecter avec Google", de: "Mit Google anmelden", es: "Iniciar sesión con Google" },
  login_failed: { en: "Login failed.", ja: "ログインに失敗しました。", zh: "登录失败。", ko: "로그인에 실패했습니다.", fr: "Échec de la connexion.", de: "Anmeldung fehlgeschlagen.", es: "Error al iniciar sesión." },
  login_err_open: { en: "The login page could not be opened.", ja: "ログインページを開けませんでした。", zh: "无法打开登录页面。", ko: "로그인 페이지를 열 수 없습니다.", fr: "Impossible d'ouvrir la page de connexion.", de: "Die Anmeldeseite konnte nicht geöffnet werden.", es: "No se pudo abrir la página de inicio de sesión." },
  login_err_browser: { en: "Failed to start the browser.", ja: "ブラウザを起動できませんでした。", zh: "无法启动浏览器。", ko: "브라우저를 시작하지 못했습니다.", fr: "Échec du démarrage du navigateur.", de: "Browser konnte nicht gestartet werden.", es: "No se pudo iniciar el navegador." },
  login_err_timeout: { en: "Login timed out.", ja: "ログインがタイムアウトしました。", zh: "登录超时。", ko: "로그인 시간이 초과되었습니다.", fr: "Délai de connexion dépassé.", de: "Zeitüberschreitung bei der Anmeldung.", es: "Tiempo de inicio de sesión agotado." },
  login_err_confirm: { en: "Could not confirm login status.", ja: "ログイン状態を確認できませんでした。", zh: "无法确认登录状态。", ko: "로그인 상태를 확인할 수 없습니다.", fr: "Impossible de confirmer l'état de connexion.", de: "Anmeldestatus konnte nicht bestätigt werden.", es: "No se pudo confirmar el estado de inicio de sesión." },
  login_err_validate: { en: "Login validation failed.", ja: "ログインの検証に失敗しました。", zh: "登录验证失败。", ko: "로그인 검증에 실패했습니다.", fr: "Échec de la validation de la connexion.", de: "Login-Überprüfung fehlgeschlagen.", es: "Falló la validación del inicio de sesión." },

  // ── Agent activity (thinking bubble / status line) ──
  status_thinking: { en: "Thinking...", ja: "考え中...", zh: "思考中...", ko: "생각 중...", fr: "Réflexion...", de: "Denkt nach...", es: "Pensando..." },
  status_working: { en: "Working...", ja: "作業中...", zh: "处理中...", ko: "작업 중...", fr: "En cours...", de: "Arbeitet...", es: "Trabajando..." },
  status_preparing: { en: "Preparing...", ja: "準備中...", zh: "准备中...", ko: "준비 중...", fr: "Préparation...", de: "Vorbereitung...", es: "Preparando..." },
  status_finishing: { en: "Finishing partial changes...", ja: "途中までの変更を反映中...", zh: "正在应用已完成的更改...", ko: "완료된 변경 사항 반영 중...", fr: "Application des modifications effectuées...", de: "Bisherige Änderungen werden übernommen...", es: "Aplicando los cambios realizados..." },

  // ── Tool activity labels (shown while the agent runs a tool) ──
  tool_read_file: { en: "Reading file", ja: "ファイルを読み取り中", zh: "正在读取文件", ko: "파일 읽는 중", fr: "Lecture du fichier", de: "Datei wird gelesen", es: "Leyendo archivo" },
  tool_list_files: { en: "Checking folder structure", ja: "フォルダ構成を確認中", zh: "正在查看目录结构", ko: "폴더 구조 확인 중", fr: "Analyse des dossiers", de: "Ordnerstruktur wird geprüft", es: "Revisando carpetas" },
  tool_list_sections: { en: "Reading document outline", ja: "文書構成を確認中", zh: "正在读取文档大纲", ko: "문서 개요 읽는 중", fr: "Lecture du plan du document", de: "Dokumentgliederung wird gelesen", es: "Leyendo el esquema" },
  tool_read_section: { en: "Reading section", ja: "セクションを読み取り中", zh: "正在读取章节", ko: "섹션 읽는 중", fr: "Lecture de la section", de: "Abschnitt wird gelesen", es: "Leyendo sección" },
  tool_replace_section: { en: "Rewriting section", ja: "セクションを書き換え中", zh: "正在改写章节", ko: "섹션 다시 쓰는 중", fr: "Réécriture de la section", de: "Abschnitt wird umgeschrieben", es: "Reescribiendo sección" },
  tool_append_to_section: { en: "Extending section", ja: "セクションに追記中", zh: "正在扩写章节", ko: "섹션에 덧붙이는 중", fr: "Extension de la section", de: "Abschnitt wird erweitert", es: "Ampliando sección" },
  tool_find_math_region: { en: "Locating equation", ja: "数式を特定中", zh: "正在定位公式", ko: "수식 찾는 중", fr: "Localisation de l'équation", de: "Formel wird gesucht", es: "Localizando ecuación" },
  tool_replace_lines: { en: "Replacing lines", ja: "行を置換中", zh: "正在替换行", ko: "행 바꾸는 중", fr: "Remplacement de lignes", de: "Zeilen werden ersetzt", es: "Reemplazando líneas" },
  tool_insert_lines: { en: "Inserting lines", ja: "行を挿入中", zh: "正在插入行", ko: "행 삽입 중", fr: "Insertion de lignes", de: "Zeilen werden eingefügt", es: "Insertando líneas" },
  tool_delete_lines: { en: "Deleting lines", ja: "行を削除中", zh: "正在删除行", ko: "행 삭제 중", fr: "Suppression de lignes", de: "Zeilen werden gelöscht", es: "Eliminando líneas" },
  tool_create_file: { en: "Creating file", ja: "ファイルを作成中", zh: "正在创建文件", ko: "파일 만드는 중", fr: "Création du fichier", de: "Datei wird erstellt", es: "Creando archivo" },
  tool_write_file: { en: "Writing file", ja: "ファイルを書き込み中", zh: "正在写入文件", ko: "파일 쓰는 중", fr: "Écriture du fichier", de: "Datei wird geschrieben", es: "Escribiendo archivo" },
  tool_apply_patch: { en: "Applying changes", ja: "変更を適用中", zh: "正在应用更改", ko: "변경 적용 중", fr: "Application des modifications", de: "Änderungen werden angewendet", es: "Aplicando cambios" },
  tool_get_compile_log: { en: "Checking build log", ja: "ビルドログを確認中", zh: "正在查看编译日志", ko: "빌드 로그 확인 중", fr: "Vérification du journal de compilation", de: "Build-Log wird geprüft", es: "Revisando registro de compilación" },
  tool_arxiv_search: { en: "Searching arXiv", ja: "arXiv を検索中", zh: "正在搜索 arXiv", ko: "arXiv 검색 중", fr: "Recherche sur arXiv", de: "arXiv wird durchsucht", es: "Buscando en arXiv" },
  tool_arxiv_bibtex: { en: "Fetching BibTeX", ja: "BibTeX を取得中", zh: "正在获取 BibTeX", ko: "BibTeX 가져오는 중", fr: "Récupération du BibTeX", de: "BibTeX wird geladen", es: "Obteniendo BibTeX" },
  tool_run_command: { en: "Running command", ja: "コマンドを実行中", zh: "正在运行命令", ko: "명령 실행 중", fr: "Exécution de la commande", de: "Befehl wird ausgeführt", es: "Ejecutando comando" },
  tool_check_environment: { en: "Checking environment", ja: "環境を確認中", zh: "正在检查环境", ko: "환경 확인 중", fr: "Vérification de l'environnement", de: "Umgebung wird geprüft", es: "Comprobando entorno" },
  tool_install_environment: { en: "Installing environment", ja: "環境をインストール中", zh: "正在安装环境", ko: "환경 설치 중", fr: "Installation de l'environnement", de: "Umgebung wird installiert", es: "Instalando entorno" },

  // ── Background-chat toast ──
  toast_done: { en: "Done", ja: "完了", zh: "完成", ko: "완료", fr: "Terminé", de: "Fertig", es: "Listo" },
  toast_issues: { en: "Issues", ja: "問題あり", zh: "有问题", ko: "문제 발생", fr: "Problèmes", de: "Probleme", es: "Problemas" },
  toast_view: { en: "View", ja: "表示", zh: "查看", ko: "보기", fr: "Afficher", de: "Anzeigen", es: "Ver" },

  // ── Delete-chat modal ──
  delete_chat: { en: "Delete chat", ja: "チャットを削除", zh: "删除对话", ko: "채팅 삭제", fr: "Supprimer la conversation", de: "Chat löschen", es: "Eliminar chat" },
  cancel: { en: "Cancel", ja: "キャンセル", zh: "取消", ko: "취소", fr: "Annuler", de: "Abbrechen", es: "Cancelar" },
  confirm_delete: { en: "Delete", ja: "削除", zh: "删除", ko: "삭제", fr: "Supprimer", de: "Löschen", es: "Eliminar" },
  new_chat: { en: "New chat", ja: "新規チャット", zh: "新对话", ko: "새 채팅", fr: "Nouvelle conversation", de: "Neuer Chat", es: "Chat nuevo" },

  // ── Composer and empty state ──
  empty_title: { en: "Axiom", ja: "Axiom", zh: "Axiom", ko: "Axiom", fr: "Axiom", de: "Axiom", es: "Axiom" },
  empty_desc: { en: "Reads, fixes, and typesets this document.", ja: "この文書を読んで、直して、組みます。", zh: "读、改、排这篇文档。", ko: "이 문서를 읽고, 고치고, 조판합니다.", fr: "Lit, corrige et compose ce document.", de: "Liest, korrigiert und setzt dieses Dokument.", es: "Lee, corrige y compone este documento." },
  start_review_title: { en: "Read through and suggest improvements", ja: "通読して改善点を挙げる", zh: "通读并提出改进点", ko: "통독하고 개선점 제안", fr: "Relire et proposer des améliorations", de: "Durchlesen und Verbesserungen vorschlagen", es: "Leer y proponer mejoras" },
  start_review_desc: { en: "Weak spots in structure, logic, and wording", ja: "構成・論理・表記の弱い所", zh: "结构、逻辑、表述的薄弱处", ko: "구성·논리·표기의 약한 곳", fr: "Points faibles de structure, logique et style", de: "Schwachstellen in Aufbau, Logik und Ausdruck", es: "Puntos débiles de estructura, lógica y redacción" },
  start_review_request: { en: "Read the whole document and list the places to improve first, with reasons.", ja: "文書全体を通読して、先に直すべき箇所を理由付きで挙げてください。", zh: "通读整篇文档，列出应优先修改的地方并说明理由。", ko: "문서 전체를 읽고 먼저 고쳐야 할 곳을 이유와 함께 제시해 주세요.", fr: "Lis tout le document et liste les endroits à améliorer en premier, avec les raisons.", de: "Lies das ganze Dokument und nenne zuerst die Stellen, die verbessert werden sollten, mit Begründung.", es: "Lee todo el documento y enumera lo que conviene mejorar primero, con motivos." },
  start_build_title: { en: "Typeset and fix problems", ja: "組版して問題を直す", zh: "排版并修复问题", ko: "조판하고 문제 고치기", fr: "Composer et corriger", de: "Setzen und Probleme beheben", es: "Componer y corregir problemas" },
  start_build_desc: { en: "Check errors and warnings, then repair", ja: "エラーと警告を確認して修正", zh: "检查错误与警告并修正", ko: "오류와 경고를 확인해 수정", fr: "Vérifier erreurs et avertissements, puis réparer", de: "Fehler und Warnungen prüfen und beheben", es: "Revisar errores y avisos, luego reparar" },
  start_build_request: { en: "Compile the document, then fix every error and the warnings that matter.", ja: "文書を組版して、エラーと意味のある警告をすべて直してください。", zh: "编译文档，然后修复所有错误和重要的警告。", ko: "문서를 조판하고 오류와 의미 있는 경고를 모두 고쳐 주세요.", fr: "Compile le document, puis corrige toutes les erreurs et les avertissements importants.", de: "Setze das Dokument und behebe alle Fehler sowie die wichtigen Warnungen.", es: "Compila el documento y corrige todos los errores y los avisos importantes." },
  start_math_title: { en: "Tidy the mathematics", ja: "数式の記法を整える", zh: "整理公式写法", ko: "수식 표기 정리", fr: "Uniformiser les formules", de: "Formeln vereinheitlichen", es: "Ordenar las fórmulas" },
  start_math_desc: { en: "amsmath, numbering, and references", ja: "amsmath への統一、番号付け、参照", zh: "统一 amsmath、编号与引用", ko: "amsmath 통일, 번호, 참조", fr: "amsmath, numérotation et références", de: "amsmath, Nummerierung und Verweise", es: "amsmath, numeración y referencias" },
  start_math_request: { en: "Unify the mathematics on amsmath: consistent environments, numbering, labels, and references.", ja: "数式を amsmath に統一してください。環境、番号付け、ラベルと参照を揃えます。", zh: "把公式统一到 amsmath：环境、编号、标签与引用保持一致。", ko: "수식을 amsmath로 통일해 주세요. 환경, 번호, 레이블과 참조를 맞춥니다.", fr: "Uniformise les formules avec amsmath : environnements, numérotation, étiquettes et références.", de: "Vereinheitliche die Formeln mit amsmath: Umgebungen, Nummerierung, Labels und Verweise.", es: "Unifica las fórmulas con amsmath: entornos, numeración, etiquetas y referencias." },
  start_bib_title: { en: "Tidy the references", ja: "参考文献を整える", zh: "整理参考文献", ko: "참고문헌 정리", fr: "Mettre en ordre la bibliographie", de: "Literatur aufräumen", es: "Ordenar la bibliografía" },
  start_bib_desc: { en: "bib entries, \\cite pairs, and style", ja: "bib と \\cite の対応、書式", zh: "bib 与 \\cite 的对应、格式", ko: "bib와 \\cite 대응, 서식", fr: "Entrées bib, \\cite et style", de: "bib-Einträge, \\cite und Stil", es: "Entradas bib, \\cite y estilo" },
  start_bib_request: { en: "Check the bibliography: every \\cite has an entry, unused entries are noted, and the style is consistent.", ja: "参考文献を点検してください。\\cite に対応する項目があるか、使われていない項目、書式の統一を確認します。", zh: "检查参考文献：每个 \\cite 都有条目，标出未使用的条目，并统一格式。", ko: "참고문헌을 점검해 주세요. 모든 \\cite에 항목이 있는지, 안 쓰인 항목, 서식 통일을 확인합니다.", fr: "Vérifie la bibliographie : chaque \\cite a une entrée, les entrées inutilisées sont signalées et le style est cohérent.", de: "Prüfe die Literatur: jedes \\cite hat einen Eintrag, ungenutzte Einträge werden genannt, der Stil ist einheitlich.", es: "Revisa la bibliografía: cada \\cite tiene su entrada, se anotan las no usadas y el estilo es coherente." },
  applied: { en: "Applied", ja: "適用済み", zh: "已应用", ko: "적용됨", fr: "Appliqué", de: "Übernommen", es: "Aplicado" },
  view_diff: { en: "Diff", ja: "差分", zh: "差异", ko: "차이", fr: "Diff", de: "Diff", es: "Diff" },
  undo_run: { en: "Undo", ja: "元に戻す", zh: "撤销", ko: "되돌리기", fr: "Annuler", de: "Rückgängig", es: "Deshacer" },
  undo_done: { en: "The change was reverted.", ja: "変更を元に戻しました。", zh: "已撤销更改。", ko: "변경을 되돌렸습니다.", fr: "La modification a été annulée.", de: "Die Änderung wurde rückgängig gemacht.", es: "Se deshizo el cambio." },
  changes_title: { en: "Changes", ja: "変更内容", zh: "更改内容", ko: "변경 내용", fr: "Modifications", de: "Änderungen", es: "Cambios" },
  close: { en: "Close", ja: "閉じる", zh: "关闭", ko: "닫기", fr: "Fermer", de: "Schließen", es: "Cerrar" },
  trace_title: { en: "Work log", ja: "作業の記録", zh: "工作记录", ko: "작업 기록", fr: "Journal", de: "Arbeitsprotokoll", es: "Registro" },
  action_copy: { en: "Copy", ja: "コピー", zh: "复制", ko: "복사", fr: "Copier", de: "Kopieren", es: "Copiar" },
  action_copied: { en: "Copied", ja: "コピーしました", zh: "已复制", ko: "복사됨", fr: "Copié", de: "Kopiert", es: "Copiado" },
  action_retry: { en: "Try again", ja: "やり直す", zh: "重试", ko: "다시 시도", fr: "Réessayer", de: "Erneut", es: "Reintentar" },
  time_now: { en: "now", ja: "たった今", zh: "刚刚", ko: "방금", fr: "à l'instant", de: "gerade eben", es: "ahora" },
  time_minutes: { en: "{n}m ago", ja: "{n}分前", zh: "{n} 分钟前", ko: "{n}분 전", fr: "il y a {n} min", de: "vor {n} Min.", es: "hace {n} min" },
  time_hours: { en: "{n}h ago", ja: "{n}時間前", zh: "{n} 小时前", ko: "{n}시간 전", fr: "il y a {n} h", de: "vor {n} Std.", es: "hace {n} h" },
  time_days: { en: "{n}d ago", ja: "{n}日前", zh: "{n} 天前", ko: "{n}일 전", fr: "il y a {n} j", de: "vor {n} T.", es: "hace {n} d" },

  // ── Login line (no overlay) ──
  login_needed: { en: "Sign in to use Axiom.", ja: "Axiom を使うにはログインしてください。", zh: "登录后即可使用 Axiom。", ko: "Axiom을 사용하려면 로그인하세요.", fr: "Connectez-vous pour utiliser Axiom.", de: "Melden Sie sich an, um Axiom zu nutzen.", es: "Inicia sesión para usar Axiom." },

  // ── Modes (the pill's words and titles are in the markup + locale dictionary) ──

  // ── Queue ──
  queued: { en: "Queued", ja: "待機中", zh: "排队中", ko: "대기 중", fr: "En attente", de: "In Warteschlange", es: "En cola" },
  queue_send_now: { en: "Send now", ja: "今すぐ送る", zh: "立即发送", ko: "지금 보내기", fr: "Envoyer maintenant", de: "Jetzt senden", es: "Enviar ahora" },
  queue_remove: { en: "Remove", ja: "取り消す", zh: "移除", ko: "제거", fr: "Retirer", de: "Entfernen", es: "Quitar" },

  // ── Rating and branch ──
  rate_up: { en: "Good reply", ja: "良い返答", zh: "回答不错", ko: "좋은 답변", fr: "Bonne réponse", de: "Gute Antwort", es: "Buena respuesta" },
  rate_down: { en: "Poor reply", ja: "いまいち", zh: "回答不好", ko: "아쉬운 답변", fr: "Mauvaise réponse", de: "Schlechte Antwort", es: "Mala respuesta" },
  rate_comment: { en: "What was wrong? (optional)", ja: "どこが良くなかったか（任意）", zh: "哪里不好？（可选）", ko: "무엇이 아쉬웠나요? (선택)", fr: "Qu'est-ce qui n'allait pas ? (facultatif)", de: "Was war falsch? (optional)", es: "¿Qué falló? (opcional)" },
  rate_send: { en: "Send", ja: "送る", zh: "发送", ko: "보내기", fr: "Envoyer", de: "Senden", es: "Enviar" },
  rate_note: { en: "The request and this reply are sent to the TeX64 team.", ja: "依頼文とこの返答が TeX64 の開発チームに送られます。", zh: "请求和此回答将发送给 TeX64 团队。", ko: "요청과 이 답변이 TeX64 팀에 전송됩니다.", fr: "La demande et cette réponse sont envoyées à l'équipe TeX64.", de: "Die Anfrage und diese Antwort gehen an das TeX64-Team.", es: "La solicitud y esta respuesta se envían al equipo de TeX64." },
  rate_thanks: { en: "Thanks, sent.", ja: "送りました。ありがとうございます。", zh: "已发送，谢谢。", ko: "보냈습니다. 감사합니다.", fr: "Merci, envoyé.", de: "Danke, gesendet.", es: "Gracias, enviado." },
  branch: { en: "Branch from here", ja: "ここから分岐", zh: "从这里分支", ko: "여기서 분기", fr: "Bifurquer ici", de: "Hier abzweigen", es: "Ramificar desde aquí" },
  branched: { en: "Branched from another chat", ja: "別のチャットから分岐", zh: "从另一个对话分支", ko: "다른 채팅에서 분기됨", fr: "Issu d'une autre conversation", de: "Abgezweigt aus einem anderen Chat", es: "Ramificado de otro chat" },

  // ── Next steps and questions ──
  answer_placeholder: { en: "Your answer", ja: "答えを書く", zh: "填写答案", ko: "답변 입력", fr: "Votre réponse", de: "Ihre Antwort", es: "Tu respuesta" },
  answer_send: { en: "Continue", ja: "進める", zh: "继续", ko: "계속", fr: "Continuer", de: "Weiter", es: "Continuar" },

  // ── Plan mode ──
  plan_note_placeholder: { en: "Anything to add or change in the plan", ja: "計画に足すこと・変えること", zh: "对计划的补充或修改", ko: "계획에 더하거나 바꿀 것", fr: "À ajouter ou à changer dans le plan", de: "Ergänzungen oder Änderungen am Plan", es: "Algo que añadir o cambiar en el plan" },
  plan_run: { en: "Start", ja: "この計画で進める", zh: "按此计划进行", ko: "이 계획으로 진행", fr: "Lancer", de: "Loslegen", es: "Empezar" },
  plan_run_request: { en: "Carry out the plan below in order. Before each step that needs facts only I have, ask, then write.", ja: "以下の計画を順に実行してください。私にしか分からないことが要る段階では、書く前に質問してください。", zh: "请按顺序执行以下计划。需要只有我知道的信息时，先提问再写。", ko: "아래 계획을 순서대로 실행해 주세요. 저만 아는 정보가 필요한 단계에서는 쓰기 전에 질문해 주세요.", fr: "Exécute le plan ci-dessous dans l'ordre. Avant chaque étape qui exige des faits que moi seul connais, pose la question, puis écris.", de: "Führe den Plan unten der Reihe nach aus. Vor jedem Schritt, der nur mir bekannte Fakten braucht, frag zuerst, dann schreib.", es: "Ejecuta el plan siguiente en orden. Antes de cada paso que necesite datos que solo yo tengo, pregunta y luego escribe." },
  plan_note_label: { en: "Note", ja: "補足", zh: "补充", ko: "보충", fr: "Note", de: "Hinweis", es: "Nota" },

  // ── Review and rules (empty chat) ──
  start_review_changes_title: { en: "Review the uncommitted changes", ja: "変更をレビュー", zh: "审阅未提交的更改", ko: "커밋 전 변경 검토", fr: "Relire les modifications non validées", de: "Nicht eingecheckte Änderungen prüfen", es: "Revisar los cambios sin confirmar" },
  start_review_changes_desc: { en: "{n} changed files, read as git diff", ja: "変更 {n} ファイルを git diff で通読", zh: "通过 git diff 通读 {n} 个已更改文件", ko: "변경된 {n}개 파일을 git diff로 통독", fr: "{n} fichiers modifiés, lus en git diff", de: "{n} geänderte Dateien, gelesen als git diff", es: "{n} archivos cambiados, leídos como git diff" },
  start_review_changes_request: { en: "Read the uncommitted changes (git diff) and point out mistakes, inconsistencies, and broken structure with file:line. Do not fix anything yet; ask me one by one whether to fix each.", ja: "コミット前の変更（git diff）を通読し、間違い・不整合・崩れを file:line 付きで指摘してください。まだ直さず、直すかどうかを一つずつ聞いてください。", zh: "通读未提交的更改（git diff），以 file:line 指出错误、不一致和结构问题。先不要修改，逐项询问我是否修改。", ko: "커밋 전 변경(git diff)을 읽고 오류·불일치·구조 문제를 file:line과 함께 지적해 주세요. 아직 고치지 말고, 고칠지 하나씩 물어봐 주세요.", fr: "Relis les modifications non validées (git diff) et signale erreurs, incohérences et structure cassée avec file:line. Ne corrige rien encore ; demande-moi une à une si je veux corriger.", de: "Lies die nicht eingecheckten Änderungen (git diff) und nenne Fehler, Widersprüche und kaputte Struktur mit file:line. Noch nichts beheben; frag mich einzeln, ob ich es beheben will.", es: "Lee los cambios sin confirmar (git diff) y señala errores, incoherencias y estructura rota con file:line. No corrijas nada aún; pregúntame uno por uno si corregirlo." },
  rules_title: { en: "Writing rules for this document", ja: "この文書の書き方の規則", zh: "这篇文档的写作规则", ko: "이 문서의 작성 규칙", fr: "Règles d'écriture de ce document", de: "Schreibregeln für dieses Dokument", es: "Reglas de escritura de este documento" },
  rules_desc: { en: "Style, notation, citations — read every turn", ja: "文体・記法・引用など。毎ターン読まれます", zh: "文体、记法、引用——每轮都会读取", ko: "문체·표기·인용 등. 매 턴 읽습니다", fr: "Style, notation, citations — lues à chaque tour", de: "Stil, Notation, Zitate – bei jedem Zug gelesen", es: "Estilo, notación, citas; se leen en cada turno" },
  rules_missing: { en: "Not written yet", ja: "まだありません", zh: "尚未编写", ko: "아직 없습니다", fr: "Pas encore écrites", de: "Noch nicht angelegt", es: "Aún no existen" },

  // ── Voice ──
  mic_transcribing: { en: "Transcribing…", ja: "文字にしています…", zh: "正在转写…", ko: "받아쓰는 중…", fr: "Transcription…", de: "Transkribiere…", es: "Transcribiendo…" },
  mic_denied: { en: "Microphone access was not granted.", ja: "マイクの使用が許可されていません。", zh: "未授予麦克风权限。", ko: "마이크 사용이 허용되지 않았습니다.", fr: "L'accès au micro n'a pas été accordé.", de: "Mikrofonzugriff wurde nicht gewährt.", es: "No se concedió acceso al micrófono." },
  mic_failed: { en: "Could not transcribe the recording.", ja: "録音を文字にできませんでした。", zh: "无法转写录音。", ko: "녹음을 받아쓸 수 없었습니다.", fr: "Impossible de transcrire l'enregistrement.", de: "Aufnahme konnte nicht transkribiert werden.", es: "No se pudo transcribir la grabación." },

  // ── Change card ──
  scope_page: { en: "p.{n}", ja: "{n}ページ", zh: "第 {n} 页", ko: "{n}쪽", fr: "p. {n}", de: "S. {n}", es: "p. {n}" },
  scope_line: { en: "line {n}", ja: "{n}行目", zh: "第 {n} 行", ko: "{n}행", fr: "ligne {n}", de: "Zeile {n}", es: "línea {n}" },

  // ── @ picker groups ──
  mention_files: { en: "Files", ja: "ファイル", zh: "文件", ko: "파일", fr: "Fichiers", de: "Dateien", es: "Archivos" },
  mention_sections: { en: "Sections", ja: "節", zh: "章节", ko: "절", fr: "Sections", de: "Abschnitte", es: "Secciones" },
  mention_labels: { en: "Labels", ja: "ラベル", zh: "标签", ko: "레이블", fr: "Étiquettes", de: "Labels", es: "Etiquetas" },
  mention_bib: { en: "References", ja: "文献", zh: "文献", ko: "문헌", fr: "Références", de: "Literatur", es: "Referencias" },
  mention_issues: { en: "Issues", ja: "問題", zh: "问题", ko: "문제", fr: "Problèmes", de: "Probleme", es: "Problemas" },
  mention_empty: { en: "No match", ja: "該当なし", zh: "无匹配", ko: "일치 없음", fr: "Aucun résultat", de: "Kein Treffer", es: "Sin coincidencias" },

  // ── Settings › Account ──
  plan_word: { en: "Plan", ja: "プラン", zh: "套餐", ko: "플랜", fr: "Plan", de: "Plan", es: "Plan" },
  usage_month: { en: "This month", ja: "今月", zh: "本月", ko: "이번 달", fr: "Ce mois-ci", de: "Diesen Monat", es: "Este mes" },
  usage_resets: { en: "Resets on {date}", ja: "{date} にリセット", zh: "{date} 重置", ko: "{date}에 초기화", fr: "Réinitialisation le {date}", de: "Zurückgesetzt am {date}", es: "Se reinicia el {date}" },
  usage_signin: { en: "Sign in to see your allowance.", ja: "ログインすると利用枠を確認できます。", zh: "登录后可查看额度。", ko: "로그인하면 사용 한도를 볼 수 있습니다.", fr: "Connectez-vous pour voir votre quota.", de: "Anmelden, um das Kontingent zu sehen.", es: "Inicia sesión para ver tu cuota." },
  open_plans: { en: "Plans", ja: "プランを見る", zh: "查看套餐", ko: "플랜 보기", fr: "Plans", de: "Pläne", es: "Planes" },
  ask_axiom: { en: "Ask Axiom", ja: "Axiom に聞く", zh: "问 Axiom", ko: "Axiom에게 묻기", fr: "Demander à Axiom", de: "Axiom fragen", es: "Preguntar a Axiom" },
  selection_word: { en: "selection", ja: "選択範囲", zh: "选区", ko: "선택 영역", fr: "sélection", de: "Auswahl", es: "selección" },
  tool_compile_document: { en: "Typesetting", ja: "組版中", zh: "正在排版", ko: "조판 중", fr: "Composition", de: "Setzen", es: "Componiendo" },
  tool_run_build: { en: "Typesetting", ja: "組版中", zh: "正在排版", ko: "조판 중", fr: "Composition", de: "Setzen", es: "Componiendo" },
  tool_git_diff: { en: "Reading the changes", ja: "変更を読んでいます", zh: "正在读取更改", ko: "변경 사항 읽는 중", fr: "Lecture des modifications", de: "Änderungen werden gelesen", es: "Leyendo los cambios" },
  tool_record_plan: { en: "Writing the plan", ja: "計画をまとめています", zh: "正在整理计划", ko: "계획 정리 중", fr: "Rédaction du plan", de: "Plan wird erstellt", es: "Redactando el plan" },
  tool_check_references: { en: "Checking labels and figures", ja: "ラベルと図表を照合中", zh: "正在核对标签与图表", ko: "레이블과 그림 확인 중", fr: "Vérification des étiquettes et figures", de: "Labels und Abbildungen werden geprüft", es: "Comprobando etiquetas y figuras" },
  tool_check_bibliography: { en: "Checking the bibliography", ja: "参考文献を照合中", zh: "正在核对参考文献", ko: "참고문헌 확인 중", fr: "Vérification de la bibliographie", de: "Literatur wird geprüft", es: "Comprobando la bibliografía" },
  tool_ask_user: { en: "Asking a question", ja: "質問しています", zh: "正在提问", ko: "질문 중", fr: "Pose une question", de: "Stellt eine Frage", es: "Haciendo una pregunta" },
  tool_propose_next_steps: { en: "Noting next steps", ja: "次の一手を記録中", zh: "正在记录下一步", ko: "다음 단계 기록 중", fr: "Note des prochaines étapes", de: "Nächste Schritte werden notiert", es: "Anotando los siguientes pasos" },
};

/** Localized AI-UI string for the current UI locale (falls back to English). */
export const aiText = (key: keyof typeof STRINGS | string): string => {
  const entry = STRINGS[key as string];
  if (!entry) return String(key);
  return entry[getUiLocale()] ?? entry.en;
};

// Backend agent statuses arrive as fixed English strings (the main process
// is locale-agnostic). Map the known ones to localized text; anything else
// (e.g. tool detail labels already localized upstream) passes through.
const BACKEND_STATUS_KEYS: Record<string, string> = {
  "Thinking...": "status_thinking",
  "Working...": "status_working",
  "Preparing...": "status_preparing",
  "Finishing partial changes...": "status_finishing",
};

/** Localize a backend-issued status string when it is one of the known ones. */
export const localizeAgentStatus = (text: string): string => {
  const key = BACKEND_STATUS_KEYS[text.trim()];
  return key ? aiText(key) : text;
};

/** Localized label for an agent tool by tool name; falls back to `fallback`. */
export const localizeToolLabel = (name: string, fallback: string): string => {
  const key = `tool_${name}`;
  const entry = STRINGS[key];
  if (!entry) return fallback;
  return entry[getUiLocale()] ?? entry.en;
};
