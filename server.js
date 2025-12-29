// server.js (使用 ES modules)
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { JSDOM } from 'jsdom';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// 定义支持的数据库列表
const SUPPORTED_DATABASES = ['pubmed', 'pmc'];

// --- Modified /api/search route using usehistory and WebEnv for reliable pagination ---
app.get('/api/search', async (req, res) => {
  try {
    const { term, db = 'pmc', retstart = 0, retmax = 10 } = req.query;

    // 参数验证
    if (!term) {
      return res.status(400).json({ error: 'Search term is required' });
    }

    if (!SUPPORTED_DATABASES.includes(db)) {
      console.error(`Invalid db parameter received: ${db}. Expected one of: ${SUPPORTED_DATABASES.join(', ')}`);
      return res.status(400).json({ error: `Invalid database. Supported databases: ${SUPPORTED_DATABASES.join(', ')}` });
    }

    const start = parseInt(retstart, 10);
    const max = parseInt(retmax, 10);
    if (isNaN(start) || start < 0) {
      return res.status(400).json({ error: 'retstart must be a non-negative integer' });
    }
    if (isNaN(max) || max <= 0 || max > 10000) {
      return res.status(400).json({ error: 'retmax must be a positive integer, max 10000' });
    }

    // Step 1: Perform initial search to get WebEnv and QueryKey
    // 使用 usehistory=y 让 NCBI 服务器记住搜索结果
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=${db}&term=${encodeURIComponent(term)}&usehistory=y&retmode=json`;

    console.log("Server: Step 1 - Calling ESearch API for history (usehistory=y) with URL:", searchUrl);
    console.log("Server: Parameters - db:", db, ", term:", term);

    const searchResponse = await axios.get(searchUrl);
    console.log("Server: ESearch History API Status:", searchResponse.status);

    if (searchResponse.status !== 200) {
        console.error("ESearch History API returned non-200 status:", searchResponse.status);
        return res.status(searchResponse.status).json({ error: `ESearch History API Error: ${searchResponse.status}` });
    }

    const esearchResult = searchResponse.data.esearchresult;
    console.log("Server: ESearch History Result:", esearchResult); // Log the full result for debugging

    if (esearchResult && esearchResult.ERROR) {
      console.error("ESearch History API Error:", esearchResult.ERROR);
      return res.status(500).json({ error: `ESearch History API Error: ${esearchResult.ERROR}` });
    }

    const count = (esearchResult && parseInt(esearchResult.count, 10)) || 0;
    const webenv = esearchResult.webenv;
    const querykey = esearchResult.querykey; // 注意：是 querykey，不是 QueryKey

    if (!webenv || !querykey) {
        console.error("ESearch History API did not return WebEnv or QueryKey. Result:", esearchResult);
        return res.status(500).json({ error: 'ESearch History API did not return required WebEnv or QueryKey for pagination.' });
    }

    console.log("Server: Got WebEnv:", webenv, "and QueryKey:", querykey, "for total count:", count);

    // Check if start index is beyond the total count
    if (start >= count) {
        console.log("Server: Requested start index", start, "is beyond total count", count);
        return res.json({ ids: [], total: count, retstart: start, retmax: max });
    }

    // Step 2: Use WebEnv and QueryKey with ESearch (not EFetch) to get the specific slice of IDs
    // 注意：这里再次使用 esearch.fcgi，并提供 WebEnv, QueryKey, retstart, 和 retmax
    const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=${db}&query_key=${querykey}&WebEnv=${webenv}&retstart=${start}&retmax=${max}&retmode=json`;

    console.log("Server: Step 2 - Calling ESearch API (not EFetch) for specific IDs with URL:", efetchUrl);

    const efetchResponse = await axios.get(efetchUrl); // Changed from esearchResponse2 or efetchResponse2
    console.log("Server: ESearch API Status for specific IDs:", efetchResponse.status);

    if (efetchResponse.status !== 200) {
        console.error("ESearch API for specific IDs returned non-200 status:", efetchResponse.status);
        return res.status(efetchResponse.status).json({ error: `ESearch API Error for specific IDs: ${efetchResponse.status}` });
    }

    // The response from esearch for IDs is a JSON object containing an 'idlist' array
    const esearchResultIds = efetchResponse.data.esearchresult; // Access the esearchresult object

    if (esearchResultIds && esearchResultIds.ERROR) {
      console.error("ESearch API for specific IDs Error:", esearchResultIds.ERROR);
      return res.status(500).json({ error: `ESearch API Error for specific IDs: ${esearchResultIds.ERROR}` });
    }

    const idList = esearchResultIds.idlist || []; // Extract the idlist array

    console.log("Server: ESearch returned", idList.length, "IDs out of", count, "total hits starting at", start);
    console.log("Server: Returned IDs:", idList); // Log the IDs we are returning

    // Send the IDs along with metadata
    res.json({
      ids: idList,
      total: count,
      retstart: start,
      retmax: max
    });

  } catch (error) {
    console.error('Error in /api/search:', error);
    if (error.response) {
      console.error('ESearch/ESearch API responded with error status:', error.response.status, error.response.data);
      res.status(error.response.status).json({ error: `ESearch/ESearch API Error: ${error.response.status}`, details: error.response.data });
    } else if (error.request) {
      console.error('No response received from ESearch/ESearch API:', error.request);
      res.status(500).json({ error: 'No response from ESearch/ESearch API', details: error.message });
    } else {
      console.error('General error during ESearch/ESearch API call:', error.message);
      res.status(500).json({ error: 'Internal Server Error during search', details: error.message });
    }
  }
});


// --- POST /api/papers 路由保持不变 ---
// ... (保留您原有的 POST /api/papers 路由代码) ...

function cleanPmcId(id) {
  if (typeof id === 'string') {
    return id.replace(/^(PMC|pmc)/i, '');
  }
  return id;
}

app.post('/api/papers', async (req, res) => {
  try {
    const { ids, db = 'pmc', retmax = 10 } = req.body;

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
});

// --- GET /api/paper/:id 路由保持不变 ---
// ... (保留您原有的 GET /api/paper/:id 路由代码) ...

app.get('/api/paper/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Paper ID is required' });
  }

  try {
    const pubmedId = id.trim();
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
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});