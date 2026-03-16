# Operations Toolkit

A collection of production planning and inventory management calculators designed for SMB operations teams.

## 🚀 Quick Start

1. Upload the entire `ops-toolkit` folder to your GitHub repository
2. Enable GitHub Pages in your repository settings
3. Access your toolkit at: `https://yourusername.github.io/yourrepo/ops-toolkit/`

## 📁 Project Structure

```
ops-toolkit/
├── index.html                          # Main dashboard/landing page
├── tools/                              # Individual calculator tools
│   ├── lead-time-calculator.html
│   ├── safety-stock-calculator.html
│   └── [future tools here]
├── assets/
│   ├── css/
│   │   └── shared-styles.css          # Common styling across all tools
│   └── js/
│       └── nav.js                     # Shared navigation component
└── README.md                          # This file
```

## 🛠️ Current Tools

### Lead Time Calculator
Calculate procurement lead times with supplier reliability factors.
- **Location**: `/tools/lead-time-calculator.html`
- **Use case**: Planning material procurement with supplier variability

### Safety Stock Calculator
Determine optimal safety stock levels using two methods:
- **Simple Method**: Quick calculation using safety factors
- **Conservative Method**: Accounts for demand and lead time variability
- **Location**: `/tools/safety-stock-calculator.html`
- **Use case**: Setting inventory buffers in Aligni or other MRP systems

## ➕ Adding New Tools

### Step 1: Create Your Calculator
Create a new HTML file in the `tools/` directory. Use this template:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Tool Name - Operations Toolkit</title>
    <link rel="stylesheet" href="../assets/css/shared-styles.css">
    <style>
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding-bottom: 40px;
        }
    </style>
</head>
<body>
    <div class="calculator-container">
        <h1>Your Tool Name</h1>
        <p class="subtitle">Brief description</p>
        
        <!-- Your calculator UI here -->
        
    </div>

    <script src="../assets/js/nav.js"></script>
    <script>
        // Initialize navigation - replace 'tool-name' with your tool's ID
        createToolkitNav('tool-name');
        
        // Your calculator logic here
    </script>
</body>
</html>
```

### Step 2: Update Navigation
Edit `assets/js/nav.js` and add your tool to the nav menu:

```javascript
<li><a href="your-tool.html" ${activePage === 'tool-name' ? 'class="active"' : ''}>Tool Name</a></li>
```

### Step 3: Update Dashboard
Edit `index.html` and add a card for your new tool:

```html
<a href="tools/your-tool.html" class="tool-card">
    <div class="tool-icon">📊</div>
    <h2>Your Tool Name</h2>
    <p>Description of what your tool does</p>
    <div class="tool-meta">
        <span>📊 Category</span>
        <span>🔧 Active</span>
    </div>
</a>
```

## 🎨 Styling Guide

The toolkit uses a consistent design language:

- **Primary Color**: Purple gradient (#667eea to #764ba2)
- **Background**: White cards on gradient background
- **Typography**: System fonts for readability
- **Spacing**: Generous padding and margins (15-40px)
- **Interaction**: Subtle hover effects and animations

All common styles are in `assets/css/shared-styles.css` - reuse these classes:
- `.calculator-container` - Main container for tools
- `.input-group` - Form input wrapper
- `.calculate-btn` - Primary action button
- `.result` - Results display
- `.info-box` - Informational callouts

## 🤖 Future Automation Integration

The toolkit is designed to support automation triggers in the future. Planned features:

1. **API Integration**: Connect calculators to Aligni or other systems
2. **Automation Dashboard**: Trigger workflows (inventory sync, reordering, etc.)
3. **Data Export**: Save calculations to CSV/JSON
4. **Historical Tracking**: Store and analyze calculation history

## 📝 Customization

### Changing Colors
Edit the gradient in each tool's `<style>` section:
```css
background: linear-gradient(135deg, #YOUR_COLOR_1 0%, #YOUR_COLOR_2 100%);
```

### Adding Company Branding
1. Update the nav brand in `assets/js/nav.js`
2. Add your logo to `assets/` and reference it in the navigation
3. Customize the footer in `index.html`

## 🔧 Maintenance

### Updating Shared Styles
When you modify `shared-styles.css`, all tools will automatically inherit the changes.

### Version Control
Consider tagging releases when you add major features:
```bash
git tag -a v1.0 -m "Initial release with lead time and safety stock calculators"
git push origin v1.0
```

## 📊 Recommended Next Tools

Based on typical SMB operations needs:
- Reorder Point Calculator
- Economic Order Quantity (EOQ) Calculator
- Inventory Turnover Analysis
- ABC Analysis Tool
- Production Capacity Planner

## 🐛 Issues & Support

For questions or issues:
1. Check that all file paths are correct (relative URLs)
2. Verify GitHub Pages is enabled and deployed
3. Test locally by opening `index.html` in a browser

## 📄 License

This toolkit is for internal operations use. Customize as needed for your organization.

---

Built for operational excellence 🚀
