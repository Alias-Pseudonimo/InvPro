import React from 'react';
import { useInventory, Sale } from '../context/InventoryContext';
import { X, Printer, Download } from 'lucide-react';

interface InvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  sale: Sale | null;
}

const InvoiceModal: React.FC<InvoiceModalProps> = ({ isOpen, onClose, sale }) => {
  const { customers, products, businessInfo } = useInventory();

  if (!isOpen || !sale) return null;

  const customer = customers.find(c => c.id === sale.customerId);
  const invoiceNumber = `INV-${sale.id.toUpperCase()}`;
  const invoiceDate = new Date(sale.date).toLocaleDateString();
  const dueDate = new Date(new Date(sale.date).getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString();

  const handlePrint = () => {
    window.print();
  };

  const handleDownload = () => {
    // Create a blob with the invoice HTML content
    const invoiceContent = document.getElementById('invoice-content');
    if (invoiceContent) {
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Invoice ${invoiceNumber}</title>
          <meta charset="UTF-8">
          <style>
            body { 
              font-family: Arial, sans-serif; 
              margin: 20px; 
              line-height: 1.4;
              color: #333;
            }
            .header { 
              display: flex; 
              justify-content: space-between; 
              margin-bottom: 30px; 
              align-items: flex-start;
            }
            .company-info { flex: 1; }
            .invoice-info { text-align: right; }
            .customer-info { margin: 20px 0; }
            table { 
              width: 100%; 
              border-collapse: collapse; 
              margin: 20px 0; 
            }
            th, td { 
              border: 1px solid #ddd; 
              padding: 12px 8px; 
              text-align: left; 
            }
            th { 
              background-color: #f8f9fa; 
              font-weight: bold;
            }
            .text-right { text-align: right; }
            .total-section {
              margin-top: 20px;
              display: flex;
              justify-content: flex-end;
            }
            .total-table {
              width: 300px;
            }
            .total-table td {
              border: 1px solid #ddd;
              padding: 8px 12px;
            }
            .total-row {
              font-weight: bold;
              border-top: 2px solid #333;
            }
            .logo {
              max-height: 80px;
              max-width: 200px;
            }
            @media print {
              body { margin: 0; }
              .no-print { display: none; }
            }
          </style>
        </head>
        <body>
          ${invoiceContent.innerHTML}
        </body>
        </html>
      `;
      
      const blob = new Blob([htmlContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Invoice-${invoiceNumber}.html`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  };

  const subtotal = sale.items.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);
  const tax = subtotal * 0.08; // 8% tax rate
  const total = subtotal + tax;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-screen overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 print:hidden">
          <h2 className="text-xl font-semibold text-gray-900">Invoice</h2>
          <div className="flex items-center space-x-2">
            <button
              onClick={handlePrint}
              className="inline-flex items-center px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Printer className="w-4 h-4 mr-2" />
              Print
            </button>
            <button
              onClick={handleDownload}
              className="inline-flex items-center px-3 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
            >
              <Download className="w-4 h-4 mr-2" />
              Download
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 p-2"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div id="invoice-content" className="p-8">
          {/* Header */}
          <div className="flex justify-between items-start mb-8">
            <div className="flex-1">
              {businessInfo.logo && (
                <img 
                  src={businessInfo.logo} 
                  alt="Company Logo" 
                  className="h-16 w-auto mb-4 logo"
                />
              )}
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{businessInfo.name}</h1>
                {businessInfo.address && (
                  <div className="text-sm text-gray-600 mt-2">
                    <p>{businessInfo.address}</p>
                    <p>{businessInfo.city}, {businessInfo.state} {businessInfo.zipCode}</p>
                    {businessInfo.phone && <p>Phone: {businessInfo.phone}</p>}
                    {businessInfo.email && <p>Email: {businessInfo.email}</p>}
                    {businessInfo.website && <p>Website: {businessInfo.website}</p>}
                  </div>
                )}
              </div>
            </div>
            <div className="text-right">
              <h2 className="text-3xl font-bold text-gray-900">INVOICE</h2>
              <div className="mt-4 text-sm">
                <p><strong>Invoice #:</strong> {invoiceNumber}</p>
                <p><strong>Date:</strong> {invoiceDate}</p>
                <p><strong>Due Date:</strong> {dueDate}</p>
                <p><strong>Status:</strong> 
                  <span className={`ml-1 px-2 py-1 text-xs rounded-full ${
                    sale.status === 'completed' 
                      ? 'bg-green-100 text-green-800'
                      : sale.status === 'pending'
                      ? 'bg-yellow-100 text-yellow-800'
                      : 'bg-red-100 text-red-800'
                  }`}>
                    {sale.status.toUpperCase()}
                  </span>
                </p>
              </div>
            </div>
          </div>

          {/* Bill To */}
          <div className="mb-8">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Bill To:</h3>
            <div className="text-sm text-gray-600">
              <p className="font-medium text-gray-900">{customer?.name || 'Unknown Customer'}</p>
              {customer?.address && <p>{customer.address}</p>}
              {customer?.city && <p>{customer.city}, {customer.state} {customer.zipCode}</p>}
              {customer?.email && <p>Email: {customer.email}</p>}
              {customer?.phone && <p>Phone: {customer.phone}</p>}
            </div>
          </div>

          {/* Items Table */}
          <div className="mb-8">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-4 py-3 text-left">Item</th>
                  <th className="px-4 py-3 text-center">Qty</th>
                  <th className="px-4 py-3 text-right">Unit Price</th>
                  <th className="px-4 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {sale.items.map((item, index) => {
                  const product = products.find(p => p.id === item.productId);
                  const itemTotal = item.quantity * item.unitPrice;
                  
                  return (
                    <tr key={index}>
                      <td className="px-4 py-3">
                        <div>
                          <p className="font-medium">{product?.name || 'Unknown Product'}</p>
                          <p className="text-sm text-gray-500">SKU: {product?.upc || 'N/A'}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">{item.quantity}</td>
                      <td className="px-4 py-3 text-right">${item.unitPrice.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right">${itemTotal.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="total-section">
            <table className="total-table">
              <tbody>
                <tr>
                  <td>Subtotal:</td>
                  <td className="text-right">${subtotal.toFixed(2)}</td>
                </tr>
                <tr>
                  <td>Tax (8%):</td>
                  <td className="text-right">${tax.toFixed(2)}</td>
                </tr>
                <tr className="total-row">
                  <td><strong>Total:</strong></td>
                  <td className="text-right"><strong>${total.toFixed(2)}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div className="mt-8 pt-8 border-t border-gray-200 text-sm text-gray-600">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">Payment Terms:</h4>
                <p>Payment is due within 30 days of invoice date.</p>
                <p>Late payments may be subject to fees.</p>
              </div>
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">Thank You!</h4>
                <p>We appreciate your business and look forward to serving you again.</p>
                {businessInfo.taxId && <p className="mt-2">Tax ID: {businessInfo.taxId}</p>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InvoiceModal;