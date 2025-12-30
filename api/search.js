// api/search.js
import cors from 'cors';
import axios from 'axios';

// Vercel API Routes 需要手动处理 CORS
const corsMiddleware = cors();

export default async function handler(req, res) {
  // 先处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  // 手动应用 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 只允许 GET 请求
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { term, db = 'pmc', retstart = 0, retmax = 10 } = req.query;

    // 参数验证
    if (!term) {
      return res.status(400).json({ error: 'Search term is required' });
    }

    const SUPPORTED_DATABASES = ['pubmed', 'pmc'];
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
    console.log("Server: ESearch History Result:", esearchResult);

    if (esearchResult && esearchResult.ERROR) {
      console.error("ESearch History API Error:", esearchResult.ERROR);
      return res.status(500).json({ error: `ESearch History API Error: ${esearchResult.ERROR}` });
    }

    const count = (esearchResult && parseInt(esearchResult.count, 10)) || 0;
    const webenv = esearchResult.webenv;
    const querykey = esearchResult.querykey;

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

    // Step 2: Use WebEnv and QueryKey with ESearch
    const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=${db}&query_key=${querykey}&WebEnv=${webenv}&retstart=${start}&retmax=${max}&retmode=json`;

    console.log("Server: Step 2 - Calling ESearch API (not EFetch) for specific IDs with URL:", efetchUrl);

    const efetchResponse = await axios.get(efetchUrl);
    console.log("Server: ESearch API Status for specific IDs:", efetchResponse.status);

    if (efetchResponse.status !== 200) {
        console.error("ESearch API for specific IDs returned non-200 status:", efetchResponse.status);
        return res.status(efetchResponse.status).json({ error: `ESearch API Error for specific IDs: ${efetchResponse.status}` });
    }

    const esearchResultIds = efetchResponse.data.esearchresult;

    if (esearchResultIds && esearchResultIds.ERROR) {
      console.error("ESearch API for specific IDs Error:", esearchResultIds.ERROR);
      return res.status(500).json({ error: `ESearch API Error for specific IDs: ${esearchResultIds.ERROR}` });
    }

    const idList = esearchResultIds.idlist || [];

    console.log("Server: ESearch returned", idList.length, "IDs out of", count, "total hits starting at", start);
    console.log("Server: Returned IDs:", idList);

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
}