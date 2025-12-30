// api/paper/[id].js
import axios from 'axios';
import { JSDOM } from 'jsdom';

// Vercel API Routes 需要手动处理 CORS
function runCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return false; // 表示已处理 OPTIONS 请求
  }
  return true; // 继续处理其他请求
}

function cleanPmcId(id) {
  if (typeof id === 'string') {
    return id.replace(/^(PMC|pmc)/i, '');
  }
  return id;
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (!runCors(req, res, null)) {
    return; // OPTIONS request handled
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query; // 从 req.query 获取动态路由参数
  if (!id) {
    return res.status(400).json({ error: 'Paper ID is required' });
  }

  try {
    const pubmedId = id.trim(); // 从动态路由参数 [id] 获取
    console.log("Server: Using PubMed ID for API call:", pubmedId);

    if (pubmedId === '$' || pubmedId.trim() === '') {
        console.error(`Invalid ID parameter received: ${pubmedId}`);
        return res.status(400).json({ error: 'Invalid Paper ID provided.' });
    }

    const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${encodeURIComponent(pubmedId)}&retmode=xml`;
    console.log("Server: Calling EFetch API for PubMed with URL:", efetchUrl);

    const response = await axios.get(efetchUrl, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000
    });

    const dom = new JSDOM(response.data, { contentType: "text/xml" });
    const xmlDoc = dom.window.document;
    const pubmedArticle = xmlDoc.querySelector("PubmedArticle");

    if (!pubmedArticle) {
      console.log("Server: Article not found in PubMed. Trying PMC database...");
      const pmcId = pubmedId;
      const efetchUrlPMC = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${encodeURIComponent(pmcId)}&retmode=xml`;
      console.log("Server: Calling EFetch API for PMC with URL:", efetchUrlPMC);

      const responsePMC = await axios.get(efetchUrlPMC, {
        headers: { 'Content-Type': 'application/xml' },
        timeout: 30000
      });

      const pmcDom = new JSDOM(responsePMC.data, { contentType: "text/xml" });
      const xmlDocPMC = pmcDom.window.document;
      const articlePMC = xmlDocPMC.querySelector("article");
      if (!articlePMC) {
        const errorElement = xmlDocPMC.querySelector("ERROR");
        if (errorElement) {
            console.error("PMC efetch returned error:", errorElement.textContent);
            return res.status(404).json({ error: 'No article found in PubMed or PMC.', details: errorElement.textContent });
        }
        return res.status(404).json({ error: 'No article found in PubMed or PMC.' });
      }

      const pmcIdParsedRaw = articlePMC.querySelector("article-id[pub-id-type='pmc']")?.textContent || '';
      const pmcIdParsed = cleanPmcId(pmcIdParsedRaw);
      console.log("单个论文详情 - 原始PMC ID from XML:", pmcIdParsedRaw, "清理后PMC ID:", pmcIdParsed);
      const uid = articlePMC.querySelector("article-id[pub-id-type='pmid']")?.textContent || '';
      const title = articlePMC.querySelector("article-title")?.textContent || '';
      const abstractElements = articlePMC.querySelectorAll("abstract p");
      let abstract = '';
      if (abstractElements.length > 0) {
        abstract = Array.from(abstractElements).map(p => p.textContent).join(' ');
      } else {
        abstract = 'No abstract available.';
      }
      const authorElements = articlePMC.querySelectorAll("contrib[contrib-type='author'] name");
      const authors = Array.from(authorElements).map(nameEl => {
        const firstName = nameEl.querySelector("given-names")?.textContent || '';
        const lastName = nameEl.querySelector("surname")?.textContent || '';
        const fullName = `${firstName} ${lastName}`.trim();
        return fullName || nameEl.textContent.trim();
      }).filter(name => name);
      const firstAuthor = authors.length > 0 ? authors[0] : 'Unknown';
      const journal = articlePMC.querySelector("journal-title")?.textContent || '';

      let pubDate = '';
      const pubDateElement = articlePMC.querySelector("pub-date");
      if (pubDateElement) {
        const year = pubDateElement.querySelector("year")?.textContent?.trim() || '';
        const month = pubDateElement.querySelector("month")?.textContent?.trim() || '';
        const day = pubDateElement.querySelector("day")?.textContent?.trim() || '';
        if (year && month && day) {
          pubDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        } else if (year && month) {
          pubDate = `${year}-${month.padStart(2, '0')}`;
        } else if (year) {
          pubDate = year;
        }
      }

      let pdfUrl = '';
      const selfUri = articlePMC.querySelector("self-uri");
      if (selfUri) {
        const selfUriContent = selfUri.getAttribute('content-type');
        const selfUriHref = selfUri.getAttribute('xlink:href');
        if (selfUriContent && selfUriContent.toLowerCase().includes('pdf') && selfUriHref) {
          pdfUrl = selfUriHref.startsWith('http') ? selfUriHref : `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcIdParsed}/pdf/`;
        }
      }
      if (!pdfUrl) {
        const extLinks = articlePMC.querySelectorAll("ext-link");
        for (let link of extLinks) {
          const extLinkType = link.getAttribute('ext-link-type');
          const extLinkHref = link.getAttribute('xlink:href');
          if (extLinkHref && extLinkHref.toLowerCase().endsWith('.pdf')) {
               pdfUrl = extLinkHref;
               break;
          }
        }
      }
      if (!pdfUrl) {
        pdfUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcIdParsed}/pdf/`;
        console.log("PDF URL constructed for single paper:", pdfUrl);
      }

      const paperData = {
        pmcid: pmcIdParsed,
        uid: uid,
        title: title.trim(),
        articletitle: abstract.trim(),
        sortfirstauthor: firstAuthor,
        authors: authors.join(', '),
        source: journal.trim(),
        pubdate: pubDate,
        pdfUrl: pdfUrl
      };

      res.json(paperData);
      return;
    }

    const pmid = pubmedArticle.querySelector("PMID")?.textContent || '';
    const articleTitle = pubmedArticle.querySelector("ArticleTitle")?.textContent || '';
    const abstractElements = pubmedArticle.querySelectorAll("Abstract > AbstractText");
    let abstract = '';
    if (abstractElements.length > 0) {
      abstract = Array.from(abstractElements).map(el => {
        const label = el.getAttribute('Label');
        const text = el.textContent.trim();
        return label ? `${label}: ${text}` : text;
      }).join(' ');
    } else {
      abstract = 'No abstract available.';
    }
    const authorList = pubmedArticle.querySelector("AuthorList");
    let authors = [];
    let firstAuthor = 'Unknown';
    if (authorList) {
      const authorElements = authorList.querySelectorAll("Author");
      authors = Array.from(authorElements).map(authorEl => {
        const firstName = authorEl.querySelector("ForeName")?.textContent || '';
        const lastName = authorEl.querySelector("LastName")?.textContent || '';
        const fullName = `${firstName} ${lastName}`.trim();
        return fullName || authorEl.querySelector("CollectiveName")?.textContent || 'Unknown';
      }).filter(name => name && name !== 'Unknown');
      firstAuthor = authors.length > 0 ? authors[0] : 'Unknown';
    }
    const journal = pubmedArticle.querySelector("MedlineTA")?.textContent || pubmedArticle.querySelector("Journal > Title")?.textContent || '';
    let pubDate = '';
    const pubDateElement = pubmedArticle.querySelector("PubDate");
    if (pubDateElement) {
      const year = pubDateElement.querySelector("Year")?.textContent?.trim() || '';
      const month = pubDateElement.querySelector("Month")?.textContent?.trim() || '';
      const day = pubDateElement.querySelector("Day")?.textContent?.trim() || '';
      if (year && month && day) {
        pubDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      } else if (year && month) {
        pubDate = `${year}-${month.padStart(2, '0')}`;
      } else if (year) {
        pubDate = year;
      } else {
        pubDate = pubmedArticle.querySelector("PubStatus > Year")?.textContent?.trim() || year;
      }
    }
    const articleIdList = pubmedArticle.querySelector("ArticleIdList");
    let pmcId = '';
    if (articleIdList) {
      const pmcIdElement = Array.from(articleIdList.querySelectorAll("ArticleId")).find(el => el.getAttribute('IdType') === 'pmc');
      pmcId = pmcIdElement ? pmcIdElement.textContent : '';
    }

    const cleanedPmcId = cleanPmcId(pmcId);
    console.log("单个论文详情 - 原始PMC ID:", pmcId, "清理后PMC ID:", cleanedPmcId);

    let pdfUrl = '';
    if (cleanedPmcId) {
      pdfUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${cleanedPmcId}/pdf/`;
      console.log("PDF URL constructed for single paper from PubMed:", pdfUrl);
    }

    const paperData = {
      pmcid: cleanedPmcId,
      uid: pmid,
      title: articleTitle.trim(),
      articletitle: abstract.trim(),
      sortfirstauthor: firstAuthor,
      authors: authors.join(', '),
      source: journal.trim(),
      pubdate: pubDate,
      pdfUrl: pdfUrl
    };

    res.json(paperData);

  } catch (error) {
    console.error('Error fetching paper details:', error);
    res.status(500).json({ error: 'Failed to fetch paper details', details: error.message });
  }
}