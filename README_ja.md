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

Gemini のプロンプト欄に `/agent <指示>` と入力します。`gemini-termium` はプロジェクトのファイルツリーと、以下のタグでローカル操作を要求するよう指示する文章を Gemini に送ります（Gemini の Web UI は `<read>` のような HTML 風タグを表示時に除去してしまうため、角括弧を使います）：

- `[read]ファイルパス[/read]`: プロジェクト内のファイルを読む。
- `[write path="ファイルパス"]内容[/write]`: ファイルを作成・上書きする。
- `[exec]コマンド[/exec]`: シェルコマンドを実行する（例: `npm test`、`git status`）。

Gemini の回答にこれらのタグが含まれると承認カードが表示されます。承認すると操作がローカルで実行され、結果がプロンプト欄に入力されて Gemini に送信され、会話が続きます。

### Human-in-the-Loop（人間による承認）ポリシー
人間の介在なしに Gemini の Web UI を自動操作することは Google の利用規約に違反する可能性があり、モデルが生成したコマンドを無人で実行することは安全でもありません。そのため以下を徹底しています：
1. **無人実行の禁止**: 人間の明示的な承認なしに、コマンド実行やファイル変更をバックグラウンドで行うことはありません。
2. **承認カード**: Gemini がツール要求を出力するたびに、操作内容・対象パス・コマンドのプレビューを表示する承認カードが画面に表示されます。
3. **人間による明示的トリガー**: `y`（承認して返信）または `n`（拒否）を押す必要があります。承認した場合にのみ操作が実行され、その結果が Gemini に送られます。

---

## 🏗 アーキテクチャ

```mermaid
flowchart TD
    User["ターミナル (Ghostty / WezTerm / iTerm2 / Kitty)"]
    Client["Termium Go クライアント (termium -s 127.0.0.1:50051)"]
    Backend["Node.js バックエンド（単一プロセス）\n- Termium gRPC サーバー (proto/bc.proto)\n- ローカルワークスペース Bridge: ファイル読み書き・コマンド実行用 HTTP API\n- Chrome DevTools Protocol (CDP) によるスクリプト注入"]
    Chrome["Google Chrome (--headless=new)\n- プロジェクトごとのプロファイル（ログイン Cookie はマスタープロファイルからコピー）"]
    DOM["Gemini WebUI (gemini.google.com)\n- Human-in-the-Loop 承認カード\n- スラッシュコマンド ポップアップ\n- コードブロック アクションボタン"]
    Workspace["ローカルワークスペース ($PWD)"]

    User <-->|Kitty Graphics / Sixel / Half-block| Client
    Client <-->|gRPC (CaptureScreenshot / SendInput)| Backend
    Backend <-->|Puppeteer & CDP| Chrome
    Chrome <-->|DOM 操作| DOM
    Backend <-->|ファイル I/O & コマンド実行| Workspace
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
git clone https://github.com/your-username/gemini-termium.git
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
| `/agent <指示>` | 自律コーディングセッションを開始します。ワークスペースのファイル構造を自動注入し、`[read]`, `[write]`, `[exec]` によるツール操作を Human-in-the-Loop 承認付きで実行します。 |
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
