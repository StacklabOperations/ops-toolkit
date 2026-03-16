// Shared navigation component for Operations Toolkit

function createToolkitNav(activePage) {
    const nav = document.createElement('div');
    nav.className = 'toolkit-nav';
    
    nav.innerHTML = `
        <a href="../index.html" class="home-button" title="Back to Operations Toolkit">
            🏠
        </a>
    `;
    
    document.body.insertBefore(nav, document.body.firstChild);
}
