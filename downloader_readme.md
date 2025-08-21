# Dropbox Downloader

An automated Dropbox file downloader using Puppeteer with resume capability, MongoDB integration, and Telegram monitoring.

## Features

- **Stealth Mode**: Uses puppeteer-extra-stealth to avoid bot detection
- **Resume Capability**: Continues from last processed file after restart
- **MongoDB Integration**: Stores failed downloads to avoid duplicates
- **Telegram Bot Monitoring**: Real-time notifications and remote control
- **Automatic Restart**: PM2 integration for session management
- **Error Handling**: Comprehensive error tracking and recovery
- **Network Interception**: Captures real download URLs
- **External Downloader**: Uses wget instead of Chrome's downloader

## Prerequisites

- Node.js 18+
- MongoDB
- Chromium browser
- wget
- PM2 (global installation)

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Install PM2 globally:

```bash
npm install -g pm2
```

4. Set up MongoDB (if not already running):

```bash
# Ubuntu/Debian
sudo apt-get install mongodb
sudo systemctl start mongodb

# Or use Docker
docker run -d -p 27017:27017 --name mongodb mongo
```

5. Configure environment variables in `.env` file

## Configuration

Edit the `.env` file with your settings:

- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token
- `TELEGRAM_CHAT_ID`: Your Telegram chat ID
- `MONGODB_URI`: MongoDB connection string
- `SHARE_URL`: Dropbox share URL to download from
- `MAX_FOLDERS_PER_SESSION`: Files to process before restart (default: 50)

## Usage

### Development Mode

```bash
npm run dev
```

### Production Mode with PM2

```bash
npm run pm2:start
```

### PM2 Commands

```bash
npm run pm2:logs     # View logs
npm run pm2:restart  # Restart the process
npm run pm2:stop     # Stop the process
```

## Telegram Bot Commands

- `/status` - Show VPS resource usage and download stats
- `/screenshot` - Take a screenshot of current browser state
- `/sh <command>` - Execute shell command on VPS
- `/count` - Count files in download folder
- `/failed` - Show failed downloads from MongoDB

## How It Works

1. **Navigation**: Opens Dropbox share URL with Puppeteer
2. **File Processing**: For each file:
   - Hovers over the row to reveal download button
   - Clicks download button
   - Handles popup and clicks "Continue with download only"
   - Intercepts network requests to capture download URL
   - Cancels Chrome download and uses wget
3. **Error Handling**:
   - 409 conflicts are saved to MongoDB
   - Resume point saved after each file
   - Automatic restart after 50 files
4. **Monitoring**:
   - Telegram notifications for progress
   - Remote control via bot commands

## Folder Structure

```
.
├── downloader.js         # Main script
├── .env                  # Environment configuration
├── package.json          # Dependencies
├── ecosystem.config.js   # PM2 configuration
├── resume_point.json     # Resume state (auto-generated)
├── final_downloads/      # Downloaded files
├── debug_screenshots/    # Debug screenshots
└── logs/                # PM2 logs
```

## Troubleshooting

### Browser Crashes

- Check memory usage with `/status` command
- Reduce `MAX_FOLDERS_PER_SESSION` if needed
- Ensure sufficient swap space on VPS

### 409 Conflicts

- These are saved to MongoDB automatically
- Check with `/failed` command
- Script continues with next file

### Download Failures

- Check wget is installed: `which wget`
- Verify write permissions to download folder
- Check disk space: `df -h`

## Notes

- Script automatically handles cookie consent
- Progressive scroll implemented for resume functionality
- All secrets are stored in `.env` file
- MongoDB indexes created automatically
- Graceful shutdown on SIGINT/SIGTERM
