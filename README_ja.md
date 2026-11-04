# gemini-termium

> **ローカルワークスペース連携を備えた、クロスプラットフォーム・ターミナル完結型 Google Gemini クライアント**
> [Termium](https://github.com/codr1/termium)（Kitty Graphics、Sixel、ASCII/Half-block）駆動、**macOS（Apple Silicon / Intel）** および **Linux** に対応。

[English](README.md) | [日本語](README_ja.md)

---

## 💡 概要

`gemini-termium` は、Web版 Google Gemini をターミナル内で直接実行し、ローカルのプロジェクトワークスペースと双方向に連携させるツールです：

- **クロスプラットフォーム描画**: Wayland コンポジタの特殊な権限を必要とせず、**macOS**（Ghostty、iTerm2、WezTerm、Kitty）および **Linux** 上でスムーズに動作します。
- **インプロセス統合バックエンド**: 単一の軽量 Node.js デーモン（メモリ消費 ~80MB）が、ヘッドレス Chrome インスタンス、ローカルワークスペース Bridge、Termium gRPC サーバーを統合管理します。
- **Google ログイン情報の永続化**: ホスト環境の Google Chrome またはマスタープロファイルから認証状態を自動的に引き継ぎ、プロジェクトごとに毎回ログインし直す必要がありません。
- **自律型エージェントモード（Human-in-the-Loop）**: ファイルツリーの自動把握、ファイルの読み込み、コードの書き込み、テストの実行などを、人間の明示的な承認のもとで行う自律コーディング支援を実現します。
- **インページ・スラッシュコマンド & オートコンプリート**:
  - `/agent <指示>`: ワークスペースのファイル構造を自動注入し、ツール実行タグを用いたエージェントセッションを開始。
  - `/apply`: Gemini の最新の回答からコードブロックや unified diff を抽出し、ローカルファイルへ直接適用。
  - `/run <コマンド>`: ワークスペース上でローカルコマンドを実行し、画面内のコンソールドロワーに標準出力を表示。
  - `/status`, `/help`: 接続情報やショートカットの即時確認。
  - スラッシュコマンド補完用ポップアップメニューの表示。
  - 回答内のコードブロック上にアクションボタンを直接注入（「Apply to file」「Run in Terminal」）。

---

## 🤖 自律エージェントモードと利用規約（TOS）遵守ポリシー

`/agent <指示>` を実行すると、`gemini-termium` は現在のワークスペースのファイルツリーとシステムプロンプトを注入し、Gemini が以下の角括弧形式ツールタグを出力するように指示します：

- `[read]ファイルパス[/read]`: ローカルファイルの内容確認を要求。
- `[write path="ファイルパス"]ファイル内容[/write]`: ローカルファイルの新規作成または変更を提案。
- `[exec]シェルコマンド[/exec]`: ローカル環境でのコマンド実行（`npm test`、`git status` など）を提案。

### 厳格な Human-in-the-Loop（人間による承認）ポリシー
**Google の利用規約（Terms of Service）を遵守**し、ローカル環境の安全性を確保するため、以下の設計を徹底しています：
1. **完全自動実行の禁止**: クライアント側が人間の介在なしに勝手にコマンドを実行したり、Gemini に自動で返答を送信することはありません。
2. **対話型承認カードの提示**: Gemini がツール呼び出しを出力すると、ターミナル上にモーダルカードが表示され、要求された操作内容、対象ファイル、実行プレビューが表示されます。
3. **人間による明示的トリガー**: ユーザーが `[y]`（Approve & Reply）または `[n]`（Reject）を押下して明示的に承認した場合にのみ、ローカル実行が行われ、その結果が送信されます。

---

## 🏗 アーキテクチャ

```mermaid
flowchart TD
    User["ターミナル (Ghostty / WezTerm / iTerm2 / Kitty)"]
    Client["Termium Go クライアント (termium -s 127.0.0.1:50051)"]
    Backend["統合 Node.js バックエンド\n- Termium gRPC サーバー (proto/bc.proto)\n- ローカルワークスペース Bridge HTTP (/apply, /run, /actions/read)\n- CDP 自動インジェクター (__GTW_CDP_BRIDGE__)"]
    Chrome["Google Chrome (--headless=new)\n- メモリ最適化 V8 フラグ\n- ワークスペースごとのCookie永続化 (user-data-dir)"]
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
npm run setup   # 使用中の OS（macOS / Linux）に合致する Termium バイナリを自動セットアップ
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
| `/apply` | Gemini の最新回答からコードブロックおよび unified diff を検出し、ローカルのファイルに直接書き込み・差分適用します。 |
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
