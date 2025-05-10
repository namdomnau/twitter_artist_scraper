// twitter_artist_scraper.js
const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const imageDownloader = require('image-downloader');
const { execFile } = require('child_process');

const BASE_DOWNLOAD_PATH = path.resolve('./twitter_artist_images');

const DEFAULT_NUM_SCROLLS = 100; // User's preferred default
const DEFAULT_MAX_IMAGES = 500;
const DEFAULT_INCLUDE_VIDEOS = true; 

const SCROLL_DELAY_BASE = 50; 
const SCROLL_DELAY_VARIANCE = 75;

const PAGE_LOAD_TIMEOUT = 90000;
const PROFILE_ELEMENT_TIMEOUT = 30000;
const MEDIA_CONTENT_TIMEOUT = 35000; 
const DOWNLOAD_TIMEOUT = 30000;

const USER_SWITCH_DELAY_BASE = 300;
const USER_SWITCH_DELAY_VARIANCE = 150;

const SHORT_ACTION_DELAY_BASE = 50;
const SHORT_ACTION_DELAY_VARIANCE = 50;

const DOWNLOAD_DELAY_BASE = 20;
const DOWNLOAD_DELAY_VARIANCE = 30;

const YTDLP_TIMEOUT = 300000; 

const MAX_CONSECUTIVE_NO_NEW_MEDIA_BREAK = 10; // MODIFIED: Increased significantly
const MIN_SCROLLS_BEFORE_NO_NEW_MEDIA_BREAK = 8; // MODIFIED: Increased

const MANUAL_INSPECTION_DELAY = 0; 
const DOWNLOAD_CONCURRENCY = 10; 
const USER_PROCESSING_CONCURRENCY = 2;

async function randomDelay(base, variance) {
    const ms = base + Math.floor(Math.random() * variance);
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getHighResImageUrl(src) {
    if (!src || !src.startsWith('https://pbs.twimg.com/media/')) {
        return null;
    }
    try {
        const url = new URL(src);
        url.searchParams.set('name', 'orig');
        return url.toString();
    } catch (e) {
        // console.warn(`Could not parse or modify image URL: ${src}. Error: ${e.message}`);
        return src;
    }
}

async function attemptToCloseOverlays(page) {
    try {
        await page.keyboard.press('Escape');
        await randomDelay(SHORT_ACTION_DELAY_BASE, SHORT_ACTION_DELAY_VARIANCE);
    } catch(e) { /* Quiet */ }
    const overlaySelectors = [
        'div[role="dialog"] div[aria-label="Close"]', 'div[data-testid="sheetDialog"] div[aria-label="Close"]',
        'div[data-testid="BottomBar"] div[aria-label="Close"]', 'div[data-testid="BottomBar"] div[aria-label="Not now"]',
        'div[aria-labelledby="modal-header"] div[aria-label="Close"]',
        'body > div[role="dialog"] button[aria-label*="Dismiss"], body > div[role="dialog"] button[aria-label*="Close"]'
    ];
    for (const selector of overlaySelectors) {
        try {
            const elements = await page.$$(selector);
            for (const element of elements) {
                if (element && await element.isIntersectingViewport()) {
                    await page.evaluate(el => el.click(), element); 
                    await randomDelay(SHORT_ACTION_DELAY_BASE * 2, SHORT_ACTION_DELAY_VARIANCE); 
                    await page.keyboard.press('Escape').catch(() => {});
                    await randomDelay(SHORT_ACTION_DELAY_BASE, SHORT_ACTION_DELAY_VARIANCE / 2);
                    break; 
                }
            }
        } catch (error) { /* Quiet */ }
    }
}

async function executePromisesInChunks(promiseFactories, chunkSize, progressCallback) {
    let allResults = [];
    // console.log(`Starting processing of ${promiseFactories.length} items in chunks of ${chunkSize}.`);
    for (let i = 0; i < promiseFactories.length; i += chunkSize) {
        const chunk = promiseFactories.slice(i, i + chunkSize);
        if (progressCallback) progressCallback(i, promiseFactories.length, chunk.length);
        
        const chunkPromises = chunk.map(factory => factory());
        const chunkResults = await Promise.allSettled(chunkPromises);
        allResults = allResults.concat(chunkResults);
        
        if (i + chunkSize < promiseFactories.length && promiseFactories.length > chunkSize) { // Only delay if there are more chunks
            const delayBetweenChunksBase = USER_SWITCH_DELAY_BASE; // Using the base user switch delay
            const delayBetweenChunksVariance = USER_SWITCH_DELAY_VARIANCE;
            // console.log(`Finished chunk. Waiting for ~${(delayBetweenChunksBase + delayBetweenChunksVariance/2)/1000}s before next chunk...`);
            await randomDelay(delayBetweenChunksBase, delayBetweenChunksVariance);
        }
    }
    // console.log(`Finished processing all ${promiseFactories.length} items.`);
    return allResults;
}


async function scrapeTwitterMedia(username, numScrolls, maxImagesToDownload, includeVideos) {
    let browser;
    // console.log(`[User: @${username}] Starting scrape.`);
    // console.log(`[User: @${username}] Config: Scrolls=${numScrolls}, Max Images=${maxImagesToDownload}, Include Videos=${includeVideos}`);

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    try {
        browser = await puppeteer.launch({
            headless: (MANUAL_INSPECTION_DELAY > 0 && username === "Rellakinoko") ? false : "new", 
            devtools: (MANUAL_INSPECTION_DELAY > 0 && username === "Rellakinoko"),
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu',
                `--user-agent=${userAgent}`
            ],
        });

        const page = await browser.newPage();
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1366, height: 768 });
        await page.setBypassCSP(true);

        const profileMediaUrl = `https://x.com/${username}/media`;
        // console.log(`[User: @${username}] Navigating to ${profileMediaUrl} ...`);
        await page.goto(profileMediaUrl, { waitUntil: 'networkidle2', timeout: PAGE_LOAD_TIMEOUT });
        
        if (MANUAL_INSPECTION_DELAY > 0 && username === "Rellakinoko") { 
            console.log(`[User: @${username}] Page loaded. Pausing for ${MANUAL_INSPECTION_DELAY / 1000}s for manual inspection...`);
            await randomDelay(MANUAL_INSPECTION_DELAY, 0);
        }

        await attemptToCloseOverlays(page);

        try {
            // console.log(`[User: @${username}] Waiting for main profile content...`);
            await page.waitForSelector('div[data-testid="primaryColumn"], div[data-testid="UserName"]', { visible: true, timeout: PROFILE_ELEMENT_TIMEOUT });
            // console.log(`[User: @${username}] Main profile content detected.`);
        } catch (e) {
            // console.warn(`[User: @${username}] Profile content did not load within timeout.`);
        }
        
        await randomDelay(1000, 500); 
        const pageContentInitial = await page.content();
        if (pageContentInitial.includes("This account doesn’t exist") || pageContentInitial.includes("Hmm...this page doesn’t exist")) {
            console.error(`[User: @${username}] Error: Account does not exist or page is unavailable.`); return false;
        }
        if (pageContentInitial.includes("These Tweets are protected")) {
            console.error(`[User: @${username}] Error: Account has protected Tweets.`); return false;
        }
        if (pageContentInitial.includes("Account suspended")) {
            console.error(`[User: @${username}] Error: Account is suspended.`); return false;
        }
        
        try {
            // console.log(`[User: @${username}] Waiting for media grid container or first media item...`);
            await page.waitForSelector(
                'div[data-testid="cellInnerDiv"] article, section[role="tabpanel"] ul, section[role="tabpanel"] div[role="listitem"], div[data-testid="cellInnerDiv"] a[href*="/status/"] img[src^="https://pbs.twimg.com/media/"]', 
                { visible: true, timeout: MEDIA_CONTENT_TIMEOUT }
            );
            // console.log(`[User: @${username}] Media grid container or first item detected.`);
        } catch (e) {
            console.warn(`[User: @${username}] No media items or grid container initially detected.`);
        }
        
        // console.log(`[User: @${username}] Starting to scroll and gather media URLs...`);
        let collectedImageUrls = new Set();
        let collectedVideoTweetUrls = new Set();
        let currentScrollAttempt = 0;
        let consecutiveNoNewMediaScrolls = 0;
        let lastKnownWindowScrollY = 0;
        let consecutiveScrollYStuck = 0;


        while (currentScrollAttempt < numScrolls ) {
            currentScrollAttempt++;
            if(!includeVideos && collectedImageUrls.size >= maxImagesToDownload) {
                // console.log(`[User: @${username}] Max image count reached.`);
                break;
            }
            // console.log(`[User: @${username}] Scroll attempt #${currentScrollAttempt}/${numScrolls}. Images: ${collectedImageUrls.size}/${maxImagesToDownload}. Video Posts: ${collectedVideoTweetUrls.size}`);
            
            await attemptToCloseOverlays(page);

            const mediaData = await page.evaluate((doIncludeVideosEval) => {
                const images = new Set();
                const videoTweetUrlsEval = new Set();
                document.querySelectorAll('article[data-testid="tweet"], div[data-testid^="tweetPhoto"], div[data-testid="cellInnerDiv"] a[href*="/status/"], section[role="tabpanel"] li[role="listitem"] article, section[role="tabpanel"] div[role="listitem"] div[role="link"]').forEach(itemContainer => {
                    let tweetUrl = null;
                    const permalinkAnchor = itemContainer.querySelector('a[href*="/status/"][role="link"] time, a[href*="/status/"][role="link"]');
                    if (permalinkAnchor) {
                        const linkElement = permalinkAnchor.closest('a[href*="/status/"]');
                        if (linkElement && linkElement.href) {
                            const href = linkElement.href;
                            const statusMatch = href.match(/(https?:\/\/(twitter|x)\.com\/[^/]+\/status\/\d+)/);
                            if (statusMatch && statusMatch[0]) tweetUrl = statusMatch[0];
                        }
                    }
                    const videoPlayer = itemContainer.querySelector('div[data-testid="videoPlayer"], div[data-testid="videoComponent"] video, div[data-testid="playButton"]');
                    const imageElements = itemContainer.querySelectorAll('img[src^="https://pbs.twimg.com/media/"][alt="Image"], img[src^="https://pbs.twimg.com/media/"][alt=""]');
                    let mediaFoundInItem = false;
                    if (doIncludeVideosEval && videoPlayer && tweetUrl) {
                        videoTweetUrlsEval.add(tweetUrl); mediaFoundInItem = true;
                    } 
                    if (!mediaFoundInItem && imageElements.length > 0) {
                        imageElements.forEach(img => {
                            if (img.src) {
                                const rect = img.getBoundingClientRect();
                                if (rect.width > 30 && rect.height > 30 && img.offsetParent !== null) {
                                    images.add(img.src);
                                }
                            }
                        });
                    }
                });
                return { imageUrls: Array.from(images), videoTweetUrls: Array.from(videoTweetUrlsEval) };
            }, includeVideos);

            let newImagesFoundThisScroll = 0;
            mediaData.imageUrls.forEach(src => {
                if (collectedImageUrls.size < maxImagesToDownload) {
                    const highResUrl = getHighResImageUrl(src);
                    if (highResUrl && !collectedImageUrls.has(highResUrl)) {
                        collectedImageUrls.add(highResUrl); newImagesFoundThisScroll++;
                    }
                }
            });

            let newVideoTweetsThisScroll = 0;
            if (includeVideos) {
                mediaData.videoTweetUrls.forEach(url => {
                    if (!collectedVideoTweetUrls.has(url)) {
                        collectedVideoTweetUrls.add(url); newVideoTweetsThisScroll++;
                    }
                });
            }
            
            await page.evaluate('window.scrollBy(0, window.innerHeight * 0.85);');
            await randomDelay(100, 50); // very short delay
            
            try {
                await page.waitForNetworkIdle({ idleTime: 1500, timeout: 7000 }); // Reduced idle time for faster attempts
            } catch (netIdleErr) { /* console.log("Network didn't become fully idle after scroll."); */ }
            
            await randomDelay(SCROLL_DELAY_BASE, SCROLL_DELAY_VARIANCE);

            let newMediaFoundThisIteration = newImagesFoundThisScroll > 0 || newVideoTweetsThisScroll > 0;
            const currentWindowScrollY = await page.evaluate(() => window.scrollY);

            if (!newMediaFoundThisIteration) {
                consecutiveNoNewMediaScrolls++;
                // console.log(`   [User: @${username}] No new media. Consecutive: ${consecutiveNoNewMediaScrolls}. ScrollY: ${currentWindowScrollY}`);
            } else {
                // console.log(`   [User: @${username}] Found ${newImagesFoundThisScroll} new images, ${newVideoTweetsThisScroll} new videos. ScrollY: ${currentWindowScrollY}`);
                consecutiveNoNewMediaScrolls = 0; 
            }
            
            if (Math.abs(currentWindowScrollY - lastKnownWindowScrollY) < 10) { // If scrollY changed by less than 10px
                consecutiveScrollYStuck++;
            } else {
                consecutiveScrollYStuck = 0;
            }
            lastKnownWindowScrollY = currentWindowScrollY;

            if (currentScrollAttempt >= MIN_SCROLLS_BEFORE_NO_NEW_MEDIA_BREAK) {
                if (consecutiveNoNewMediaScrolls >= MAX_CONSECUTIVE_NO_NEW_MEDIA_BREAK) {
                     console.log(`[User: @${username}] No new media for ${consecutiveNoNewMediaScrolls} scrolls after ${currentScrollAttempt} attempts. Assuming end.`);
                     break;
                }
                // If scrollY has been stuck for 3+ times AND no new media for 2+ times, then break
                if (consecutiveScrollYStuck >= 3 && consecutiveNoNewMediaScrolls >= 2) {
                    console.log(`[User: @${username}] Window scroll position stuck for ${consecutiveScrollYStuck} attempts and no new media for ${consecutiveNoNewMediaScrolls}. Assuming end.`);
                    break;
                }
            }
        }
        
        const debugDir = path.join(BASE_DOWNLOAD_PATH, '_debug_files');
        await fs.ensureDir(debugDir);
        
        if (collectedImageUrls.size === 0 && (!includeVideos || collectedVideoTweetUrls.size === 0)) {
            console.log(`[User: @${username}] No media found after scrolling.`);
            const timestamp = Date.now();
            const screenshotPath = path.join(debugDir, `${username}_no_media_after_scroll_${timestamp}.png`);
            const htmlPath = path.join(debugDir, `${username}_page_content_after_scroll_${timestamp}.html`);
            try {
                await page.screenshot({ path: screenshotPath, fullPage: true });
                console.log(`   Saved debug screenshot to: ${screenshotPath}`);
                await fs.writeFile(htmlPath, await page.content());
                console.log(`   Saved page HTML to: ${htmlPath}`);
            } catch (debugError) {
                console.error(`   Failed to save debug files: ${debugError.message}`);
            }
            return true; 
        }
        
        const downloadPath = path.join(BASE_DOWNLOAD_PATH, username.replace(/[^\w.-]/g, '_'));
        await fs.ensureDir(downloadPath);

        if (collectedImageUrls.size > 0) {
            console.log(`\n[User: @${username}] Collected ${collectedImageUrls.size} image URLs. Starting download...`);
            const imageDownloadPromisesFactories = Array.from(collectedImageUrls).map((imgUrl, index) => {
                return async () => {
                    let filename; 
                    try {
                        const urlObj = new URL(imgUrl); const pathnameParts = urlObj.pathname.split('/');
                        const mediaIdWithFormat = pathnameParts[pathnameParts.length - 1]; let baseName = mediaIdWithFormat;
                        let extension = 'jpg'; const formatParam = urlObj.searchParams.get('format');
                        if (formatParam && ['jpg', 'jpeg', 'png', 'webp'].includes(formatParam.toLowerCase())) {
                            extension = formatParam.toLowerCase(); if (baseName.includes('.')) baseName = baseName.substring(0, baseName.lastIndexOf('.'));
                        } else if (mediaIdWithFormat.includes('.')) {
                            const parts = mediaIdWithFormat.split('.'); const lastPart = parts.pop();
                            if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(lastPart.toLowerCase())) { extension = lastPart.toLowerCase(); baseName = parts.join('.');}
                            else { baseName = mediaIdWithFormat; }
                        } filename = `${baseName}.${extension}`;
                    } catch (e) { filename = `image_${index}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${imgUrl.split('.').pop().split('?')[0] || 'jpg'}`; }
                    const filePath = path.join(downloadPath, filename);
                    if (await fs.pathExists(filePath)) return { status: 'skipped', path: filePath };
                    try {
                        await imageDownloader.image({ url: imgUrl, dest: filePath, timeout: DOWNLOAD_TIMEOUT, headers: { 'User-Agent': userAgent }});
                        return { status: 'fulfilled', path: filePath };
                    } catch (err) { console.error(`   [Img @${username}] Failed ${filename}: ${err.message.slice(0,100)}`); return { status: 'rejected' };}
                };
            });
            const imageResults = await executePromisesInChunks(imageDownloadPromisesFactories, DOWNLOAD_CONCURRENCY, 
                (start, total, cs) => console.log(`[Img @${username}] Chunk ${Math.floor(start/cs)+1}/${Math.ceil(total/cs)}`)
            );
            const successfulImageDownloads = imageResults.filter(r => r.status === 'fulfilled' || r.status === 'skipped').length;
            console.log(`[User: @${username}] Finished image downloads. ${successfulImageDownloads} successful/skipped.`);
        } else { console.log(`[User: @${username}] No image URLs collected.`); }

        if (includeVideos && collectedVideoTweetUrls.size > 0) {
            console.log(`\n[User: @${username}] Found ${collectedVideoTweetUrls.size} video tweets. Starting download...`);
            const videoDownloadPromiseFactories = Array.from(collectedVideoTweetUrls).map((tweetUrl, index) => {
                return async () => {
                    const tweetIdMatch = tweetUrl.match(/\/status\/(\d+)/);
                    const videoFileNameBase = tweetIdMatch ? tweetIdMatch[1] : `video_${index}_${Date.now()}`;
                    const potentialExistingVideo = path.join(downloadPath, `${videoFileNameBase}.mp4`);
                    if (await fs.pathExists(potentialExistingVideo)) return { status: 'skipped', tweet: tweetUrl };
                    return new Promise((resolve) => {
                        const ytdlpArgs = [
                            '--no-warnings', '--no-progress', '--no-playlist', '-P', downloadPath, 
                            '-o', `${videoFileNameBase}.%(ext)s`, '--merge-output-format', 'mp4', 
                            '--socket-timeout', '60', tweetUrl
                        ];
                        const ytDlpProcess = execFile('yt-dlp', ytdlpArgs, { timeout: YTDLP_TIMEOUT });
                        let stderrData = ''; ytDlpProcess.stderr.on('data', (data) => { stderrData += data; });
                        ytDlpProcess.on('close', (code) => {
                            if (code === 0) resolve({ status: 'fulfilled', tweet: tweetUrl });
                            else { console.error(`   [Vid @${username}] yt-dlp code ${code} for ${tweetUrl}. Stderr: ${stderrData.slice(-300)}`); resolve({ status: 'rejected' });}
                        });
                        ytDlpProcess.on('error', (err) => {
                            console.error(`   [Vid @${username}] yt-dlp start fail for ${tweetUrl}: ${err.message}`);
                            if (err.message.includes('ENOENT')) console.error("   'yt-dlp' not found.");
                            resolve({ status: 'rejected' });
                        });
                    });
                };
            });
            const videoResults = await executePromisesInChunks(videoDownloadPromiseFactories, DOWNLOAD_CONCURRENCY,
                 (start, total, cs) => console.log(`[Vid @${username}] Chunk ${Math.floor(start/cs)+1}/${Math.ceil(total/cs)}`)
            );
            const successfulVideoDownloads = videoResults.filter(r => r.status === 'fulfilled' || r.status === 'skipped').length;
            console.log(`[User: @${username}] Finished video processing. ${successfulVideoDownloads} successful/skipped.`);
        } else if (includeVideos) { console.log(`[User: @${username}] No video tweet URLs collected.`); }

        return true;
    } catch (error) {
        console.error(`[User: @${username}] CRITICAL ERROR:`, error);
        const debugDir = path.join(BASE_DOWNLOAD_PATH, '_debug_files');
        await fs.ensureDir(debugDir);
        const timestamp = Date.now();
        const screenshotPath = path.join(debugDir, `${username}_ERROR_${timestamp}.png`);
        if (browser && browser.isConnected()) {
            try {
                const pages = await browser.pages();
                const errorPage = pages[pages.length -1] || await browser.newPage();
                 if (errorPage && !errorPage.isClosed()) {
                    await errorPage.screenshot({ path: screenshotPath, fullPage: true });
                    console.log(`   Saved an error screenshot to: ${screenshotPath}`);
                 } else { /* console.log("Could not get a valid page for error screenshot."); */ }
            } catch (ssError) { console.error("Could not take error screenshot:", ssError); }
        }
        return false;
    } finally {
        if (browser) {
            await browser.close();
            // console.log(`[User: @${username}] Browser closed.`);
        }
    }
}

function printUsageAndExit() {
    console.error("\nUsage:");
    console.error("  node twitter_artist_scraper.js <twitter_username> [num_scrolls] [max_images] [-v|--videos]");
    console.error("  OR");
    console.error("  node twitter_artist_scraper.js -f <filepath> [num_scrolls] [max_images] [-v|--videos]");
    console.error("\nParameters:");
    console.error("  <twitter_username>: Single Twitter username (without @).");
    console.error("  -f, --file <filepath>: Path to a text file containing usernames (one per line).");
    console.error("  [num_scrolls]: Optional. Number of scroll downs. Default: " + DEFAULT_NUM_SCROLLS);
    console.error("  [max_images]: Optional. Max images to download per user. Default: " + DEFAULT_MAX_IMAGES);
    console.error("  -v, --videos: Optional. Include video download attempts (requires yt-dlp). Default: " + DEFAULT_INCLUDE_VIDEOS);
    console.error("\nExamples:");
    console.error("  node twitter_artist_scraper.js TwitterDev 5 20");
    console.error("  node twitter_artist_scraper.js TwitterDev 5 20 -v");
    console.error("  node twitter_artist_scraper.js -f ./user_list.txt 10 50 --videos");
    process.exit(1);
}

(async () => {
    const args = process.argv.slice(2);
    let usernamesToScrape = [];
    let numScrolls = DEFAULT_NUM_SCROLLS;
    let maxImages = DEFAULT_MAX_IMAGES;
    let includeVideos = DEFAULT_INCLUDE_VIDEOS; 

    if (args.length < 1) printUsageAndExit();

    let currentArgIndex = 0;
    if (args[currentArgIndex] === '-f' || args[currentArgIndex] === '--file') {
        currentArgIndex++;
        if (currentArgIndex >= args.length) { console.error("Error: File path expected."); printUsageAndExit(); }
        const filePath = args[currentArgIndex++];
        try {
            if (!await fs.pathExists(filePath)) { console.error(`Error: File not found: ${filePath}`); process.exit(1); }
            const fileContent = await fs.readFile(filePath, 'utf-8');
            usernamesToScrape = fileContent.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#'));
            if (usernamesToScrape.length === 0) { console.error(`Error: No valid usernames in file: ${filePath}.`); process.exit(1); }
        } catch (err) { console.error(`Error reading file ${filePath}: ${err.message}`); process.exit(1); }
    } else {
        const singleUsername = args[currentArgIndex++];
        if (!singleUsername || singleUsername.startsWith('-')) { console.error("Error: Username or -f flag required."); printUsageAndExit(); }
        usernamesToScrape.push(singleUsername);
    }
    
    const remainingArgs = args.slice(currentArgIndex);
    let optArgIndex = 0;
    if (remainingArgs.length > optArgIndex && !isNaN(parseInt(remainingArgs[optArgIndex], 10))) {
        numScrolls = parseInt(remainingArgs[optArgIndex++], 10);
    }
    if (remainingArgs.length > optArgIndex && !isNaN(parseInt(remainingArgs[optArgIndex], 10))) {
        maxImages = parseInt(remainingArgs[optArgIndex++], 10);
    }
    // Video flag is now default true, so we only look for it if we want to *change* the default
    // This example assumes the user would provide a hypothetical `--no-videos` if they wanted to disable.
    // Since the user's provided constants set DEFAULT_INCLUDE_VIDEOS = true, we don't need to explicitly check for -v here
    // unless we add a flag to *disable* it. For now, `includeVideos` will remain `true` from the default.
    if (remainingArgs.length > optArgIndex && (remainingArgs[optArgIndex] === '-v' || remainingArgs[optArgIndex] === '--videos')) {
        // includeVideos is already true by default, this just consumes the arg
        optArgIndex++;
    }
    
    if(optArgIndex < remainingArgs.length) {
        console.warn(`Warning: Unrecognized arguments found: ${remainingArgs.slice(optArgIndex).join(' ')}. Please check your command.`);
        printUsageAndExit();
    }

    if (isNaN(numScrolls) || numScrolls <= 0) { console.error(`Error: Scrolls must be positive. Got: ${numScrolls}`); printUsageAndExit(); }
    if (isNaN(maxImages) || maxImages <= 0) { console.error(`Error: Max images must be positive. Got: ${maxImages}`); printUsageAndExit(); }

    console.log(`--- Starting batch processing for ${usernamesToScrape.length} user(s) ---`);
    console.log(`User concurrency: ${USER_PROCESSING_CONCURRENCY}, Media download concurrency: ${DOWNLOAD_CONCURRENCY}`);

    const userScrapingPromiseFactories = usernamesToScrape.map((rawUsername, i) => {
        return async () => {
            const twitterUsername = rawUsername.startsWith('@') ? rawUsername.substring(1) : rawUsername;
            // console.log(`\n--- [User Batch ${i+1}/${usernamesToScrape.length}] Processing user: @${twitterUsername} ---`);
            return scrapeTwitterMedia(twitterUsername, numScrolls, maxImages, includeVideos);
        };
    });

    const results = await executePromisesInChunks(userScrapingPromiseFactories, USER_PROCESSING_CONCURRENCY, 
        (start, total, cs) => console.log(`--- Processing user chunk: ${Math.floor(start/cs)+1} / ${Math.ceil(total/cs)} (Users ${start+1} to ${Math.min(start+cs, total)}) ---`)
    );

    let SucceededCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    let FailedCount = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value === false)).length;

    console.log("\n--- All user processing complete. ---");
    console.log(`Successfully processed: ${SucceededCount} user(s).`);
    console.log(`Failed or had issues: ${FailedCount} user(s).`);
})();
