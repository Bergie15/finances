# Finances

A small, private finance tracker that runs entirely in your browser and keeps all of
your data in plain CSV files. There is no server, no account, and no tracking — the
page is static HTML/JS, so nothing you enter ever leaves your computer.

## Features

- **Dashboard** — income, expenses, net and savings rate for any month (or all time),
  a 12‑month income vs. expenses chart, spending by category, budget progress and
  recent transactions.
- **Transactions** — add, edit and delete; search; filter by month, category and type;
  sort any column. Categories are suggested from earlier transactions with the same
  description.
- **Budgets** — monthly limits per category, with progress bars that turn amber near
  the limit and red when you go over.
- **Budget helper** — click **Create a budget for me** on the Budgets tab. It averages
  your spending per category over the last 3, 6 or 12 months, suggests a tidy monthly
  limit for each, and shows your plan against your income as needs / wants / savings
  (with the 50/30/20 rule as a guide). Pick a savings goal (10%, 20% or 30% of income)
  and it trims "wants" to get there, telling you if the goal isn't realistic. Tweak any
  number, mark categories as needs or wants, then save.
- **CSV import** — import exports from your bank. Columns are auto-detected and you can
  remap them; supports a single signed amount column or separate debit/credit columns,
  US or day-first dates, and a "flip signs" option. Re-importing the same file skips
  transactions you already have.
- **Light and dark mode**, works on phones.

## Where your data lives

Two files, readable and editable in Excel, Numbers, Google Sheets or any text editor:

| File | Columns |
| --- | --- |
| `transactions.csv` | `id,date,description,category,amount,account,notes` |
| `budgets.csv` | `category,monthly_budget` |

- `date` is `YYYY-MM-DD`. `amount` is negative for money out and positive for money in.
- Transactions with the category **Transfer** (e.g. paying off a credit card from
  checking) are left out of income and expense totals.

How the files are saved depends on your browser:

- **Chrome, Edge, Brave, Opera (desktop):** on the **Data** tab, click
  **Choose folder…** and pick a folder (for example one inside Dropbox/iCloud/OneDrive
  if you want it synced). The app reads `transactions.csv` and `budgets.csv` from that
  folder and rewrites them automatically every time you make a change. After a browser
  restart you'll be asked to click **Reconnect** once to re-approve access.
- **Safari, Firefox, mobile browsers:** these can't write to a folder, so the app keeps a
  copy in the browser's local storage between visits. Click **Export** in the top bar to
  download your CSVs (all files, or just transactions or budgets) and **Import / Open** on
  the Data tab to load them back. The status next to the button says **Not exported** (and
  the button gets a dot) whenever you have changes that aren't in an exported file yet.

See [`examples/`](examples) for sample files, including a typical bank export.

## Hosting on GitHub Pages

The site is plain static files at the repo root (`index.html`, `styles.css`, `app.js`,
`csv.js`) — there's no build step.

1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose the branch (e.g. `main`) and the `/ (root)` folder, then **Save**.
4. After a minute the site is live at `https://<your-username>.github.io/finances/`.

Your data is not stored on GitHub — every visitor's data stays on their own device.

## Running locally

Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

(Folder access requires the page to be served over `https://` or `http://localhost`.)
