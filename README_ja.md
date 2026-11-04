# gemini-termium

> **ローカルワークスペース連携を備えた、クロスプラットフォーム・ターミナル完結型 Google Gemini クライアント**
> [Termium](https://github.com/codr1/termium)（Kitty Graphics、Sixel、ASCII/Half-block）駆動、**macOS（Apple Silicon / Intel）** および **Linux** に対応。

[English](README.md) | [日本語](README_ja.md)

---

## 💡 概要

`gemini-termium` は、Gemini の Web 版（gemini.google.com）をターミナルから使えるようにし、さらに Gemini がカレントディレクトリのプロジェクトに対して「ファイルを読む・書く・コマンドを実行する」ことを、**あなたが 1 回ずつ承認した場合にのみ**可能にするツールです。

### 仕組み

1. `gemini-termium` がウィンドウを持たない（ヘッドレス）Google Chrome を起動し、Gemini を開きます。
2. ターミナル向けブラウザクライアント [Termium](https://github.com/codr1/termium) が、そのページを画像（Kitty Graphics / Sixel）またはテキストアート（ASCII / ハーフブロック）としてターミナルに表示し、キー入力を転送します。
3. Gemini のページに注入された小さなスクリプトが、スラッシュコマンド、コードブロックのボタン、承認カードを追加し、プロジェクトディレクトリ内のファイル操作とコマンド実行を行うローカルサーバーと通信します。

API キーは不要です。通常の Google アカウントで Gemini の Web UI をそのまま利用します。

### 主な機能

- **自律エージェントモード（`/agent`）**: プロジェクトのファイルツリーを Gemini に渡し、Gemini がファイルの読み込み・書き込み・コマンド実行を要求します。すべての要求は承認カードに表示され、`y` を押すまで何も実行されません。
- **スラッシュコマンド**（補完ポップアップ付き）:
  - `/agent <指示>`: エージェントセッションを開始。
  - `/run <コマンド>`: プロジェクトディレクトリでシェルコマンドを実行し、出力を画面内のコンソールに表示。
  - `/status`, `/help`: 接続情報とコマンド一覧を表示。
- **「Run Locally」ボタン**: Gemini の回答内のシェルコードブロックに表示されます。
- **ログインは 1 回だけ**: Google のログイン情報は専用の Chrome プロファイル（「マスタープロファイル」）に保存され、すべてのプロジェクトで再利用されます。初回起動時、通常の Google Chrome にログイン済みであればそこから自動でコピーされます。未ログインの場合は `--login` を 1 度実行してください（[起動方法](#起動方法)参照）。
- **軽量**: 1 つの Node.js プロセスが Chrome、ローカルサーバー、Termium を管理します（Chrome 本体を除き約 80MB）。
- **対応環境**: macOS（Apple Silicon / Intel）と Linux。Ghostty、iTerm2、WezTerm、Kitty などのターミナルで動作します。

---

## 🤖 エージェントモードと承認ポリシー

Gemini のプロンプト欄に `/agent <指示>` と入力します。`gemini-termium` はプロジェクトのファイルツリーを送信し、対話型ペアプログラミングセッションを開始します。

Gemini のセーフティガードレール（RCEやプロンプトインジェクションの誤検知フィルター）に抵触しないよう、標準的な Markdown 形式で操作を提案します：

- **ファイルの確認・コマンド実行**: ````bash ```` ブロックで提案されます（例: ファイル確認の `cat README.md` や、検証コマンド `npm test`、`git status`）。
- **ファイルの作成・編集**: コードブロックの先頭行に対象パスを指定して提案されます（例: `// filepath: src/index.js`）。
- ※ 後方互換性のため、従来のタグ形式（`[read]`, `[write path="..."]`, `[exec]`）も引き続き自動認識されます。

Gemini が操作を提案すると承認カードが表示されます。承認（`y` キー）すると操作がローカルで実行され、結果がプロンプト欄に入力されて Gemini に送信され、会話がステップごとに継続します。

### Human-in-the-Loop（人間による承認）ポリシー
人間の介在なしに Gemini の Web UI を自動操作することは Google の利用規約に違反する可能性があり、モデルが生成したコマンドを無人で実行することは安全でもありません。そのため以下を徹底しています：
1. **無人実行の禁止**: 人間の明示的な承認なしに、コマンド実行やファイル変更をバックグラウンドで行うことはありません。
2. **安全な Skill 連携（Enterprise ガードレール対応）**:
   Gemini Enterprise 等の厳しいセーフティ環境では、ユーザープロンプト内に直接ルールを書き込むと C2（遠隔操作）通信と誤認される場合があります。同梱の [`SKILL.md`](./SKILL.md) を Gemini の公式機能である **Skills**（または Gems）に `pair-programmer` として登録することで、指示がプラットフォーム側のシステムプロンプトとして安全に解釈されます。`/agent <指示>` を実行すると、自動的に `@pair-programmer <指示>` に展開されます。
   - 別のスキル名を使用したい場合: `--skill <名前>` を指定するか、`/agent @<名前> <指示>` と入力します。
   - スキル機能を使用しない場合: `--skill none` で起動できます。
2. **承認カード**: Gemini がツール要求を出力するたびに、操作内容・対象パス・コマンドのプレビューを表示する承認カードが画面に表示されます。
3. **人間による明示的トリガー**: `y`（承認して返信）または `n`（拒否）を押す必要があります。承認した場合にのみ操作が実行され、その結果が Gemini に送られます。

---

## 🏗 アーキテクチャ

```mermaid
flowchart TD
    User["ターミナル (Ghostty / WezTerm / iTerm2 / Kitty)"]
    Client["Termium Go クライアント (termium -s 127.0.0.1:50051)"]
    Backend["Node.js バックエンド（単一プロセス）<br>- Termium gRPC サーバー (proto/bc.proto)<br>- ローカルワークスペース Bridge: ファイル読み書き・コマンド実行用 HTTP API<br>- Chrome DevTools Protocol (CDP) によるスクリプト注入"]
    Chrome["Google Chrome (--headless=new)<br>- プロジェクトごとのプロファイル（ログイン Cookie はマスタープロファイルからコピー）"]
    DOM["Gemini WebUI (gemini.google.com)<br>- Human-in-the-Loop 承認カード<br>- スラッシュコマンド ポップアップ<br>- コードブロック アクションボタン"]
    Workspace["ローカルワークスペース ($PWD)"]

    User <-->|"Kitty Graphics / Sixel / Half-block"| Client
    Client <-->|"gRPC: CaptureScreenshot / SendInput"| Backend
    Backend <-->|"Puppeteer & CDP"| Chrome
    Chrome <-->|"DOM 操作"| DOM
    Backend <-->|"ファイル I/O & コマンド実行"| Workspace
```

---

## 🚀 クイックスタート

### 前提条件
1. **Google Chrome** がインストールされていること:
   - macOS: `/Applications/Google Chrome.app`
   - Linux: `/usr/bin/google-chrome` または `/usr/bin/chromium`
2. **Node.js** (>= 20)
3. 画像描画に対応したターミナル環境:
   - **Kitty Graphics**: [Ghostty](https://ghostty.org/)、[Kitty](https://sw.kovidgoyal.net/kitty/)、[WezTerm](https://wezfurlong.org/wezterm/)（推奨、トゥルーカラー描画）
   - **Sixel Graphics**: [iTerm2](https://iterm2.com/)、foot、xterm（VT340 モード）
   - **ASCII / Half-block フォールバック**: あらゆるターミナルで動作（Alacritty、macOS標準ターミナルなど）

### インストール

```bash
git clone https://github.com/aYutaSekiguchi/gemini-termium.git
cd gemini-termium
npm install
npm run setup   # OS / CPU に合った Termium バイナリをダウンロード
```

### 起動方法

作業対象のプロジェクトディレクトリに移動して実行します：

```bash
cd /path/to/my-project
npx gemini-termium
```

#### 初回 Google ログイン
ホストマシンの Google Chrome にログインしていない場合や、セッションの初回認証を行う場合：

```bash
npx gemini-termium --login
```
デスクトップ上に Chrome ウィンドウが開きます。Google アカウントでログインを完了したらウィンドウを閉じてください。以降は全ワークスペースでログイン状態が自動的に引き継がれます。

---

## ⚡ スラッシュコマンド & 操作一覧

| コマンド | 説明 |
| :--- | :--- |
| `/agent <指示>` | 自律コーディングセッションを開始します。ワークスペースのファイル構造を自動注入し、Gemini Skill（デフォルト: `@pair-programmer`）として Human-in-the-Loop 承認付きで安全に実行します。 |
| `/run <コマンド>` | ワークスペースディレクトリ上でシェルコマンドを実行し、出力を画面内のドロワーに表示します。 |
| `/status` | 現在のワークスペースパス、接続状況、ポート番号などをトースト表示します。 |
| `/help` | 利用可能なスラッシュコマンドと使い方のヒントを表示します。 |

---

## 🧪 テスト実行

```bash
npm test
```
ユニットテスト、ヘッドレス Chrome、Termium gRPC との結合および E2E テスト全スイートを実行します。

---

## 📄 ライセンス
MIT
