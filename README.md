# fmy-ncbi-proxy-server-only

`my-ncbi-proxy-server-only is the backend proxy service for the free-read-scholar project. It is a standalone Node.js (Express) server whose primary function is to act as a proxy, forwarding API requests from the frontend application to the NCBI EUtils API.

## 技术栈

*   **后端:** Node.js (Express)
*   **代理服务器:** `my-ncbi-proxy-server-only` (Node.js)

## 功能

*   学术论文搜索
*   论文详情展示
*   访问开放获取的全文链接
*   ...

## 安装与运行

1.  **安装 Node.js 依赖:**
    ```bash
    # 进入后端目录
    cd my-ncbi-proxy-server-only
    npm install
    # 进入前端目录 (假设前端在项目根目录或另一个子目录)
    # cd frontend-directory
    # npm install
    ```

2.  **启动后端服务:**
    ```bash
    # 在 my-ncbi-proxy-server-only 目录下
    npm start
    ```

3.  **启动前端开发服务器 (如果适用):**
    ```bash
    # 在前端目录下
    npm start
    ```

## 部署

本项目已部署至 Vercel: [Your Vercel URL Here] (当你部署后替换此处链接)

## 作者

2427177988