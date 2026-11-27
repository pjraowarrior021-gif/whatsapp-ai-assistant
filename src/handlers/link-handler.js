import { privacyLog } from '../privacy.js';
import { sendWhatsAppMessage } from '../whatsapp.js';
import { extractUrl, extractUserPromptAside, fetchAndExtractArticle } from '../web-scraper.js';
import { extractYouTubeVideoId, isYouTubeDomain, fetchYouTubeVideoData, buildYouTubeAiPrompt } from '../youtube.js';
import { isInstagramUrl, fetchInstagramPostData, buildInstagramAiPrompt } from '../instagram.js';

/**
 * Resolves shared URLs (YouTube, Instagram, or web articles) into enriched AI prompts.
 * Handles SSRF rejection, truncated link grounding fallbacks, and user prompt extraction.
 *
 * @param {object} params
 * @param {string} params.from
 * @param {string} params.sanitizedText
 * @param {string} params.cleanRawText
 * @param {object|null} params.mediaPart
 * @param {string} params.messageType
 * @returns {Promise<{ aborted: boolean, effectivePrompt: string, articleHeader: object|null, forceGrounding: boolean }>}
 */
export async function resolveUrlPrompt({ from, sanitizedText, cleanRawText, mediaPart, messageType }) {
  let articleHeader = null;
  let forceGrounding = false;
  let effectivePrompt = sanitizedText;

  const foundUrl =
    !mediaPart && messageType === 'text' && !cleanRawText.startsWith('/') ? extractUrl(cleanRawText) : null;

  if (!foundUrl) {
    return { aborted: false, effectivePrompt, articleHeader, forceGrounding };
  }

  const userPromptAside = extractUserPromptAside(sanitizedText, foundUrl);
  const ytVideoId = extractYouTubeVideoId(foundUrl);
  const isYtDomain = isYouTubeDomain(foundUrl);

  if (ytVideoId) {
    const videoData = await fetchYouTubeVideoData(ytVideoId);
    if (!videoData.ok) {
      if (userPromptAside) {
        privacyLog('info', 'YOUTUBE_FETCH_FALLBACK_GROUNDING', { error: videoData.error, videoId: ytVideoId });
        forceGrounding = true;
        effectivePrompt = [
          `The user shared this YouTube video link: ${foundUrl}`,
          `User instruction: "${userPromptAside}"`,
          `Note: Direct video details could not be retrieved (${videoData.error || 'Video may be private, restricted, or unavailable'}). Use Google Search Grounding to assist the user with their request and any clues provided, and politely let them know the video details couldn't be loaded directly.`,
        ].join('\n\n');
      } else {
        await sendWhatsAppMessage(
          from,
          `⚠️ *YouTube Error:* Could not load video details (${videoData.error || 'Video may be private, restricted, or unavailable'}).`
        );
        return { aborted: true, effectivePrompt, articleHeader, forceGrounding };
      }
    } else {
      effectivePrompt = buildYouTubeAiPrompt(videoData, userPromptAside);
      articleHeader = {
        title: `▶️ ${videoData.title} (${videoData.author})`,
        url: videoData.url,
      };
      if (!videoData.hasTranscript) {
        forceGrounding = true;
      }
    }
    return { aborted: false, effectivePrompt, articleHeader, forceGrounding };
  }

  if (isYtDomain) {
    if (userPromptAside) {
      privacyLog('info', 'YOUTUBE_INCOMPLETE_LINK_FALLBACK_GROUNDING', { url: foundUrl });
      forceGrounding = true;
      effectivePrompt = [
        `The user shared this YouTube link: ${foundUrl}`,
        `User instruction: "${userPromptAside}"`,
        `Note: The YouTube link appears incomplete, truncated, or invalid (YouTube video IDs must be exactly 11 characters).`,
        `Use Google Search Grounding to assist the user with their request (for example, identifying songs, mix tracks, or artists from any lyrics or clues they provided). In your response, helpfully answer their question and politely mention that the YouTube link was cut short or couldn't be opened directly, inviting them to provide more lyrics, clues, or the complete link if needed.`,
      ].join('\n\n');
      return { aborted: false, effectivePrompt, articleHeader, forceGrounding };
    }

    await sendWhatsAppMessage(
      from,
      `⚠️ *YouTube Notice:* The link appears incomplete or truncated (${foundUrl}). YouTube video links require an 11-character video ID (e.g. youtube.com/shorts/VIDEO_ID). Please check the link or share the video title/lyrics!`
    );
    return { aborted: true, effectivePrompt, articleHeader, forceGrounding };
  }

  if (isInstagramUrl(foundUrl)) {
    const instaData = await fetchInstagramPostData(foundUrl);
    effectivePrompt = buildInstagramAiPrompt(instaData, userPromptAside);
    const mediaBadge = instaData.isReel ? 'Instagram Reel' : 'Instagram Post';
    articleHeader = {
      title: `📸 ${instaData.title || mediaBadge} (${instaData.author})`,
      url: instaData.url,
    };
    return { aborted: false, effectivePrompt, articleHeader, forceGrounding: true };
  }

  const article = await fetchAndExtractArticle(foundUrl);
  if (!article.ok) {
    if (article.reason === 'ssrf_blocked') {
      await sendWhatsAppMessage(
        from,
        '⚠️ *Security Alert:* Access to internal, loopback, or private network addresses is blocked for security.'
      );
      return { aborted: true, effectivePrompt, articleHeader, forceGrounding };
    }
    if (article.reason === 'too_large') {
      await sendWhatsAppMessage(from, '⚠️ *Webpage Error:* Webpage content exceeds maximum allowed size (16MB).');
      return { aborted: true, effectivePrompt, articleHeader, forceGrounding };
    }

    if (userPromptAside) {
      privacyLog('info', 'WEBPAGE_FETCH_FALLBACK_GROUNDING', { reason: article.reason, url: foundUrl });
      forceGrounding = true;
      const failureNote =
        article.reason === 'http_404'
          ? 'Page not found (HTTP 404). The link may be broken, incomplete, or expired.'
          : article.reason === 'timeout'
            ? 'Webpage download timed out.'
            : `Direct HTML fetching was blocked or limited (${article.reason || 'Could not load URL'}).`;
      effectivePrompt = [
        `The user shared this link: ${foundUrl}`,
        `User instruction: "${userPromptAside}"`,
        `Note: ${failureNote} Use Google Search Grounding to look up details about this URL, topic, or any clues provided by the user, and answer their question clearly. Politely mention that the link couldn't be loaded directly if relevant.`,
      ].join('\n\n');
    } else if (
      article.reason === 'http_429' ||
      article.reason === 'content_too_short' ||
      article.reason === 'http_403' ||
      article.reason === 'http_401'
    ) {
      privacyLog('info', 'WEBPAGE_FETCH_FALLBACK_GROUNDING', { reason: article.reason, url: foundUrl });
      forceGrounding = true;
      effectivePrompt = [
        `The user shared this link: ${foundUrl}`,
        'Please summarize the content and topic of this webpage.',
        'Note: Direct HTML fetching was blocked or limited by the host server. Use Google Search Grounding to look up details about this URL and topic, providing clear highlights and key takeaway points for WhatsApp.',
      ].join('\n\n');
      articleHeader = { title: `🔗 ${foundUrl}`, url: foundUrl };
    } else {
      const errorMsg =
        article.reason === 'http_404'
          ? `⚠️ *Webpage Notice:* The webpage was not found (HTTP 404). The link may be broken, incomplete, or deleted. Please check the URL and try again.`
          : article.reason === 'timeout'
            ? `⚠️ *Webpage Notice:* Webpage download timed out. Please verify the URL and try again.`
            : `⚠️ *Webpage Notice:* Failed to fetch webpage content (${article.reason || 'Could not load URL'}).`;
      await sendWhatsAppMessage(from, errorMsg);
      return { aborted: true, effectivePrompt, articleHeader, forceGrounding };
    }
    return { aborted: false, effectivePrompt, articleHeader, forceGrounding };
  }

  if (article.needsGrounding) {
    forceGrounding = true;
  }
  effectivePrompt = userPromptAside
    ? `The user shared this article: [${article.title || foundUrl}](${foundUrl})\n\nUser Question/Instruction: "${userPromptAside}"\n\nArticle Content:\n"""${article.text}"""`
    : `Summarize this webpage clearly in 3-5 WhatsApp bullet points with key takeaways:\n\nTitle: ${article.title || 'Webpage'}\nURL: ${foundUrl}\n\nContent:\n"""${article.text}"""`;
  articleHeader = { title: article.title || 'Webpage Summary', url: foundUrl };

  return { aborted: false, effectivePrompt, articleHeader, forceGrounding };
}
