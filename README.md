# Google Tasks Bidirectional Sync - Setup Guide

This guide will help you set up bidirectional syncing between two Google accounts using GitHub Actions (completely free).

## Prerequisites

- Two Google accounts with Google Tasks
- A GitHub account
- Basic command line knowledge

## Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable the **Google Tasks API**:
   - In the search bar, type "Google Tasks API"
   - Click on it and click "Enable"

## Step 2: Create OAuth Credentials

1. In Google Cloud Console, go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. If prompted, configure the OAuth consent screen:
   - User Type: External
   - App name: "Tasks Sync" (or whatever you prefer)
   - Add your email addresses
   - Add scope: `https://www.googleapis.com/auth/tasks`
4. Create OAuth client ID:
   - Application type: **Desktop app**
   - Name: "Tasks Sync Client"
5. Download the JSON file (you'll need the client ID and secret)

## Step 3: Get Refresh Tokens for Both Accounts

You need to get a refresh token for each Google account. Run this script locally:

```javascript
// get-tokens.js
const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const open = require('open');
const destroyer = require('server-destroy');

const CLIENT_ID = 'YOUR_CLIENT_ID';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const SCOPES = ['https://www.googleapis.com/auth/tasks'];

async function getTokens() {
  return new Promise((resolve, reject) => {
    const oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    // Generate the url that will be used for the consent dialog
    const authorizeUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent', // Force consent screen to ensure we get a refresh token
    });

    // Create a local server to receive the oauth callback
    const server = http
      .createServer(async (req, res) => {
        try {
          if (req.url.indexOf('/oauth2callback') > -1) {
            // Acquire the code from the querystring
            const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
            const code = qs.get('code');
            
            console.log('\n✓ Authorization code received');
            res.end('Authentication successful! You can close this tab and return to the terminal.');

            // Exchange authorization code for tokens
            const { tokens } = await oauth2Client.getToken(code);
            
            console.log('\n=================================');
            console.log('SUCCESS! Your refresh token:');
            console.log('=================================');
            console.log(tokens.refresh_token);
            console.log('=================================\n');
            console.log('Save this refresh token in your GitHub secrets.');
            console.log('You only need to do this once per account.\n');

            // Shut down the server
            server.destroy();
            resolve(tokens);
          }
        } catch (e) {
          reject(e);
        }
      })
      .listen(3000, () => {
        // Open the browser to the authorize url to start the workflow
        console.log('\n=================================');
        console.log('Opening browser for authorization...');
        console.log('=================================\n');
        console.log('If the browser does not open automatically, visit this URL:');
        console.log(authorizeUrl);
        console.log('\n');
        open(authorizeUrl, { wait: false }).then(cp => cp.unref());
      });

    destroyer(server);
  });
}

// Run the script
console.log('=================================');
console.log('Google Tasks OAuth Token Generator');
console.log('=================================\n');
console.log('This script will:');
console.log('1. Open your browser');
console.log('2. Ask you to sign in with Google');
console.log('3. Generate a refresh token\n');
console.log('Run this script TWICE - once for each Google account.\n');

node getTokens()
  .then(() => {
    console.log('Done! Run this script again for your second account.');
    process.exit(0);
  })
  .catch(error => {
    console.error('Error getting tokens:', error);
    process.exit(1);
  });
```

**Run this twice** (once for each account):

```bash
# Install googleapis locally
npm install googleapis

# Replace CLIENT_ID and CLIENT_SECRET in get-tokens.js
node get-tokens.js
```

1. Open the URL it prints
2. Sign in with the Google account
3. Copy the authorization code
4. Paste it into the terminal
5. Save the refresh token that's printed
6. **Repeat for the second account**

## Step 4: Create GitHub Repository

1. Create a new GitHub repository (can be private)
2. Create the following file structure:

```
your-repo/
├── .github/
│   └── workflows/
│       └── sync.yml          # GitHub Actions workflow
├── src/
│   └── index.ts              # Main sync script
├── package.json
├── tsconfig.json
└── .gitignore
```

3. Add this to `.gitignore`:
```
node_modules/
dist/
.env
```

Note: We intentionally don't ignore `sync-state.json` because the workflow commits it to track sync progress.

## Step 5: Add Secrets to GitHub

1. Go to your repository on GitHub
2. Navigate to **Settings > Secrets and variables > Actions**
3. Click **New repository secret** and add each of these:

   - `GOOGLE_CLIENT_ID`: Your OAuth client ID
   - `GOOGLE_CLIENT_SECRET`: Your OAuth client secret
   - `ACCOUNT_A_REFRESH_TOKEN`: Refresh token for first account
   - `ACCOUNT_B_REFRESH_TOKEN`: Refresh token for second account

## Step 6: Deploy the Code

1. Copy all the files (index.ts, package.json, tsconfig.json, sync.yml) to your repository
2. Make sure the file structure matches:
   - `src/index.ts` - the main TypeScript file
   - `.github/workflows/sync.yml` - the workflow file
   - `package.json` and `tsconfig.json` in the root

3. Push to GitHub:

```bash
git add .
git commit -m "Initial commit: Google Tasks sync"
git push origin main
```

## Step 7: Test the Sync

1. Go to **Actions** tab in your GitHub repository
2. Click on "Sync Google Tasks" workflow
3. Click **Run workflow** button to trigger it manually
4. Watch the logs to see if it works

## How It Works

- **Sync frequency**: Every 10 minutes (configurable in sync.yml)
- **Conflict resolution**: Latest timestamp wins
- **Deletions**: If you delete a task in one account, it deletes from the other
- **New tasks**: Created in both accounts automatically
- **Updates**: Any changes sync both ways

## Customization

### Sync specific task list by name

By default, the script syncs the default task list (first one in each account). To sync a specific list by name:

**Option 1: Use environment variable (recommended)**

Add a new secret in GitHub:
- Go to Settings > Secrets and variables > Actions
- Add secret: `TASK_LIST_NAME` with the exact name of your task list (e.g., "Work Tasks")
- The list name must exist in both accounts with the exact same name

**Option 2: Hardcode in the script**

Edit `src/index.ts` and uncomment/modify these lines in the `syncTaskLists()` method:

```typescript
// Replace the default list selection with:
const taskListA = await this.findTaskListByName(this.tasksApiA, 'Work Tasks');
const taskListB = await this.findTaskListByName(this.tasksApiB, 'Work Tasks');
if (!taskListA || !taskListB) {
  console.error('Could not find "Work Tasks" list in both accounts');
  return;
}
```

Replace `'Work Tasks'` with your actual task list name.

**Example**: If you have lists named "Personal", "Work", and "Shopping", you can sync just the "Work" list by:
1. Adding `TASK_LIST_NAME` secret with value: `Work`
2. Or hardcoding `'Work'` in the script

**Note**: The list name must match exactly (case-sensitive) in both accounts.

### Change sync frequency

Edit `.github/workflows/sync.yml`:

```yaml
schedule:
  - cron: '*/10 * * * *'  # Change */10 to */15 for 15 minutes, etc.
```

Cron syntax:
- `*/10` = every 10 minutes
- `*/30` = every 30 minutes  
- `0 * * * *` = every hour
- `0 */2 * * *` = every 2 hours

### Sync specific task lists

By default, it syncs the default task list. To sync specific lists, modify the `syncTaskLists()` method in `index.ts` to select different lists by name or index.

### Disable deletion syncing

Remove the deletion logic blocks in the sync code if you don't want deletions to propagate.

## Troubleshooting

**"No task lists found"**
- Make sure both accounts have at least one task list
- Verify the refresh tokens are correct

**"Invalid credentials"**
- Check that all secrets are set correctly in GitHub
- Verify your OAuth client ID and secret

**"Quota exceeded"**
- Google Tasks API has usage limits. Every 10 minutes should be fine, but if you have issues, increase the interval

**Sync state issues**
- The sync state is stored as a GitHub artifact
- If something goes wrong, you can go to Actions > latest run > Artifacts and delete the sync-state artifact to start fresh

## Cost

Everything is **completely free**:
- Google Cloud: Free tier includes 1M API calls/month
- GitHub Actions: 2,000 minutes/month free (this uses ~5 seconds per run)
- Running every 10 minutes = ~4,300 runs/month = ~6 hours of GitHub Actions time

## Security Notes

- Never commit your secrets to the repository
- Keep your OAuth credentials secure
- Use repository secrets for all sensitive data
- Consider making the repository private

## Support

If you encounter issues:
1. Check the GitHub Actions logs for error messages
2. Verify all secrets are set correctly
3. Test OAuth tokens manually using the get-tokens.js script
4. Check Google Cloud Console for API errors
