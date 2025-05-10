# Twitter Profile Media Scraper

This script scrapes images from the "Media" tab of public Twitter profiles.

## **Prerequisites:**
1. Node.js installed (version 16.x or higher recommended).
2. npm (Node Package Manager), which comes with Node.js.

## **Setup:**
1. Save the script `twitter_artist_scraper.js` to a directory.
2. Open a terminal or command prompt in that directory.
3. Install the required npm packages by running:
   npm install puppeteer fs-extra image-downloader

## **How to Run:**
Execute the script from your terminal using Node.js. There are two ways to specify users:

**A) Single User:**
node twitter_artist_scraper.js <twitter_username> [num_scrolls] [max_images]

**B) Multiple Users from File:**
node twitter_artist_scraper.js -f <filepath_to_usernames_file> [num_scrolls] [max_images]
OR
node twitter_artist_scraper.js --file <filepath_to_usernames_file> [num_scrolls] [max_images]


### **Parameters:**
- `<twitter_username>`: (Required for single user mode) The Twitter username of the artist/profile (e.g., TwitterDev). Do not include the "@" symbol, or if you do, the script will attempt to remove it.
- `-f <filepath>` or `--file <filepath>`: (Required for file mode) Path to a plain text file containing Twitter usernames, one username per line. Lines starting with '#' will be treated as comments and ignored. Empty lines are also ignored.
- `[num_scrolls]`: (Optional) The number of times the script should scroll down the media page to load more images for *each* user. Defaults to 10 if not provided.
- `[max_images]`: (Optional) The maximum number of images to download for *each* user. The script will stop collecting URLs once this limit is reached, or after all scrolls are done. Defaults to 50 if not provided.

### **Examples:**
- To scrape up to 50 images from the user "TwitterDev" with 10 scrolls (default behavior):
  node twitter_artist_scraper.js TwitterDev

- To scrape up to 20 images from "elonmusk" with 5 scrolls:
  node twitter_artist_scraper.js elonmusk 5 20

- To scrape users from a file named `artists.txt` (located in the same directory as the script), using 15 scrolls and downloading up to 100 images per user:
  node twitter_artist_scraper.js -f ./artists.txt 15 100

**Format for the usernames file (e.g., `artists.txt`):**

## This is a list of artists

artist1
@AnotherArtist # The @ symbol will be automatically removed


## **Output:**
- Images will be downloaded into a subdirectory named after the Twitter username within a main folder called `twitter_artist_images`.
  For example: `./twitter_artist_images/artist1/`, `./twitter_artist_images/AnotherArtist/`
- The script will print progress messages to the console for each user.
- A short delay is introduced between processing different users from a list to be more considerate to Twitter's servers.

## **Notes:**
- This script is intended for public Twitter profiles. Scraping protected profiles will not work as it does not handle login.
- Twitter's website structure can change, which might break the script's selectors. If it stops working, the CSS selectors within `twitter_artist_scraper.js` (especially in `page.evaluate`) may need updating.
- Be respectful of Twitter's terms of service and rate limits. Avoid running the script excessively or with very large lists of users too frequently.
- The script attempts to download the highest resolution images available by modifying image URLs (`name=orig`).
- If you encounter issues with `puppeteer` (e.g., Chromium download failures), consult the Puppeteer troubleshooting documentation. You might need to install additional system dependencies on Linux.
- For debugging, you can change `headless: "new"` to `headless: false` in `twitter_artist_scraper.js` to see the browser window.
