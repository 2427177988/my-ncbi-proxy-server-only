// api/papers.js
import axios from 'axios';
import { JSDOM } from 'jsdom';

// Vercel API Routes 需要手动处理 CORS
const corsOptions = {
  origin: '*', // 或者更具体地限制来源
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// 手动处理 CORS
function runCors(req, res, next) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', corsOptions.origin);
  res.setHeader('Access-Control-Allow-Methods', corsOptions.methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', corsOptions.allowedHeaders.join(', '));
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

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { ids, db = 'pmc', retmax = 10 } = req.body;

    const SUPPORTED_DATABASES = ['pubmed', 'pmc'];

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs array is required and cannot be empty' });
    }

    if (!SUPPORTED_DATABASES.includes(db)) {
      console.error(`Invalid db parameter received in POST /api/papers: ${db}. Expected one of: ${SUPPORTED_DATABASES.join(', ')}`);
      return res.status(400).json({ error: `Invalid database. Supported databases: ${SUPPORTED_DATABASES.join(', ')}` });
    }

    const cleanedIds = ids.map(cleanPmcId).filter(id => id !== '' && id.trim() !== '');

    if (cleanedIds.length === 0) {
        console.log("All provided IDs were empty or only contained 'PMC' prefix after cleaning.");
        return res.status(400).json({ error: 'No valid IDs provided after cleaning.' });
    }

    console.log("Server: Fetching details for IDs:", cleanedIds, "from database:", db);

    const idStr = cleanedIds.join(',');
    const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=${db}&id=${idStr}&retmode=xml`;

    console.log("Server: Calling EFetch API with URL:", efetchUrl);

    const response = await axios.get(efetchUrl, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000
    });

    const dom = new JSDOM(response.data, { contentType: "text/xml" });
    const xmlDoc = dom.window.document;

    let papers = [];

    if (db === 'pubmed') {
      const pubmedArticles = xmlDoc.querySelectorAll("PubmedArticle");
      for (let pubmedArticle of pubmedArticles) {
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
        console.log("原始PMC ID:", pmcId, "清理后PMC ID:", cleanedPmcId);

        let pdfUrl = '';
        if (cleanedPmcId) {
          pdfUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${cleanedPmcId}/pdf/`;
          console.log("PDF URL constructed:", pdfUrl);
        }

        papers.push({
          pmcid: cleanedPmcId,
          uid: pmid,
          title: articleTitle.trim(),
          articletitle: abstract.trim(),
          sortfirstauthor: firstAuthor,
          authors: authors.join(', '),
          authorsArray: authors,
          source: journal.trim(),
          pubdate: pubDate,
          pdfUrl: pdfUrl
        });
      }
    } else if (db === 'pmc') {
      const articles = xmlDoc.querySelectorAll("article");
      for (let article of articles) {
        const pmcIdInXmlRaw = article.querySelector("article-id[pub-id-type='pmc']")?.textContent || '';
        const pmcIdInXml = cleanPmcId(pmcIdInXmlRaw);
        console.log("原始PMC ID from XML:", pmcIdInXmlRaw, "清理后PMC ID:", pmcIdInXml);
        const pmid = article.querySelector("article-id[pub-id-type='pmid']")?.textContent || '';
        const title = article.querySelector("article-title")?.textContent || '';
        const abstractElements = article.querySelectorAll("abstract p");
        let abstract = '';
        if (abstractElements.length > 0) {
          abstract = Array.from(abstractElements).map(p => p.textContent).join(' ');
        } else {
          abstract = 'No abstract available.';
        }
        const authorElements = article.querySelectorAll("contrib[contrib-type='author'] name");
        const authors = Array.from(authorElements).map(nameEl => {
          const firstName = nameEl.querySelector("given-names")?.textContent || '';
          const lastName = nameEl.querySelector("surname")?.textContent || '';
          const fullName = `${firstName} ${lastName}`.trim();
          return fullName || nameEl.textContent.trim();
        }).filter(name => name);
        const firstAuthor = authors.length > 0 ? authors[0] : 'Unknown';
        const journal = article.querySelector("journal-title")?.textContent || '';

        let pubDate = '';
        const pubDateElement = article.querySelector("pub-date");
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
        const selfUri = article.querySelector("self-uri");
        if (selfUri) {
          const selfUriContent = selfUri.getAttribute('content-type');
          const selfUriHref = selfUri.getAttribute('xlink:href');
          if (selfUriContent && selfUriContent.toLowerCase().includes('pdf') && selfUriHref) {
            pdfUrl = selfUriHref.startsWith('http') ? selfUriHref : `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcIdInXml}/pdf/`;
          }
        }
        if (!pdfUrl) {
          const extLinks = article.querySelectorAll("ext-link");
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
          pdfUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcIdInXml}/pdf/`;
          console.log("PDF URL constructed:", pdfUrl);
        }

        papers.push({
          pmcid: pmcIdInXml,
          uid: pmid,
          title: title.trim(),
          articletitle: abstract.trim(),
          sortfirstauthor: firstAuthor,
          authors: authors.join(', '),
          authorsArray: authors,
          source: journal.trim(),
          pubdate: pubDate,
          pdfUrl: pdfUrl
        });
      }
    } else {
        console.error(`Unsupported database for EFetch: ${db}`);
        return res.status(400).json({ error: `Unsupported database for EFetch: ${db}` });
    }

    if (db === 'pubmed') {
        const pmcIds = papers.filter(p => p.pmcid).map(p => p.pmcid);
        if (pmcIds.length > 0) {
          const pmcEfetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcIds.join(',')}&retmode=xml`;
          const pmcResponse = await axios.get(pmcEfetchUrl, {
            headers: { 'Content-Type': 'application/xml' },
            timeout: 30000
          });

          const pmcDom = new JSDOM(pmcResponse.data, { contentType: "text/xml" });
          const pmcXmlDoc = pmcDom.window.document;

          const pmcArticles = pmcXmlDoc.querySelectorAll("article");

          for (let article of pmcArticles) {
            const pmcIdInXmlRaw = article.querySelector("article-id[pub-id-type='pmc']")?.textContent || '';
            const pmcIdInXml = cleanPmcId(pmcIdInXmlRaw);
            console.log("PMC补充信息 - 原始PMC ID from XML:", pmcIdInXmlRaw, "清理后PMC ID:", pmcIdInXml);

            const paperIndex = papers.findIndex(p => p.pmcid === pmcIdInXml);
            if (paperIndex !== -1) {
              const titleInXml = article.querySelector("article-title")?.textContent || papers[paperIndex].title;
              const abstractElementsInXml = article.querySelectorAll("abstract p");
              let abstractInXml = papers[paperIndex].articletitle;
              if (abstractElementsInXml.length > 0) {
                abstractInXml = Array.from(abstractElementsInXml).map(p => p.textContent).join(' ');
              }
              const authorElementsInXml = article.querySelectorAll("contrib[contrib-type='author'] name");
              const authorsInXml = Array.from(authorElementsInXml).map(nameEl => {
                const firstName = nameEl.querySelector("given-names")?.textContent || '';
                const lastName = nameEl.querySelector("surname")?.textContent || '';
                const fullName = `${firstName} ${lastName}`.trim();
                return fullName || nameEl.textContent.trim();
              }).filter(name => name);
              const firstAuthorInXml = authorsInXml.length > 0 ? authorsInXml[0] : papers[paperIndex].sortfirstauthor;
              const journalInXml = article.querySelector("journal-title")?.textContent || papers[paperIndex].source;

              let pubDateInXml = papers[paperIndex].pubdate;
              const pubDateElementInXml = article.querySelector("pub-date");
              if (pubDateElementInXml) {
                const year = pubDateElementInXml.querySelector("year")?.textContent?.trim() || '';
                const month = pubDateElementInXml.querySelector("month")?.textContent?.trim() || '';
                const day = pubDateElementInXml.querySelector("day")?.textContent?.trim() || '';
                if (year && month && day) {
                  pubDateInXml = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
                } else if (year && month) {
                  pubDateInXml = `${year}-${month.padStart(2, '0')}`;
                } else if (year) {
                  pubDateInXml = year;
                }
              }

              let pdfUrlInXml = '';
              const selfUri = article.querySelector("self-uri");
              if (selfUri) {
                const selfUriContent = selfUri.getAttribute('content-type');
                const selfUriHref = selfUri.getAttribute('xlink:href');
                if (selfUriContent && selfUriContent.toLowerCase().includes('pdf') && selfUriHref) {
                  pdfUrlInXml = selfUriHref.startsWith('http') ? selfUriHref : `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcIdInXml}/pdf/`;
                }
              }
              if (!pdfUrlInXml) {
                const extLinks = article.querySelectorAll("ext-link");
                for (let link of extLinks) {
                  const extLinkType = link.getAttribute('ext-link-type');
                  const extLinkHref = link.getAttribute('xlink:href');
                  if (extLinkHref && extLinkHref.toLowerCase().endsWith('.pdf')) {
                       pdfUrlInXml = extLinkHref;
                       break;
                  }
                }
              }
              if (!pdfUrlInXml) {
                pdfUrlInXml = `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcIdInXml}/pdf/`;
                console.log("PDF URL constructed from PMC XML:", pdfUrlInXml);
              }

              papers[paperIndex] = {
                ...papers[paperIndex],
                title: titleInXml.trim(),
                articletitle: abstractInXml.trim(),
                sortfirstauthor: firstAuthorInXml,
                authors: authorsInXml.join(', '),
                authorsArray: authorsInXml,
                source: journalInXml.trim(),
                pubdate: pubDateInXml,
                pdfUrl: pdfUrlInXml
              };
            }
          }
        }
    }

    res.json({ papers, total: papers.length });

  } catch (error) {
    console.error('Error in /api/papers:', error);
    res.status(500).json({ error: 'Failed to fetch papers', details: error.message });
  }
}