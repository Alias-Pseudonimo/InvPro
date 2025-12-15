import React, { useState } from 'react';
import { useInventory, Sale } from '../context/InventoryContext';
import { X, Plus, Trash2 } from 'lucide-react';

interface SaleItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

interface SaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  sale?: Sale | null;
  mode: 'add' | 'edit';
}

const SaleModal: React.FC<SaleModalProps> = ({ isOpen, onClose, sale, mode }) => {
  const { addSale, updateSale, customers, products } = useInventory();
  const [formData, setFormData] = useState({
    customerId: sale?.customerId || '',
    date: new Date().toISOString().split('T')[0],
    status: 'pending' as 'pending' | 'completed' | 'cancelled'
  });
  const [items, setItems] = useState<SaleItem[]>([
    { productId: '', quantity: 1, unitPrice: 0 }
  ]);

  React.useEffect(() => {
    if (sale && mode === 'edit') {
      setFormData({
        customerId: sale.customerId,
        date: sale.date,
        status: sale.status
      });
      setItems(sale.items);
    } else {
      setFormData({
        customerId: '',
        date: new Date().toISOString().split('T')[0],
        status: 'pending'
      });
      setItems([{ productId: '', quantity: 1, unitPrice: 0 }]);
    }
  }, [sale, mode]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const validItems = items.filter(item => item.productId && item.quantity > 0);
    if (validItems.length === 0) {
      alert('Please add at least one valid item to the sale.');
      return;
    }
    
    const totalAmount = validItems.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);
    
    if (mode === 'add') {
      addSale({
        customerId: formData.customerId,
        items: validItems,
        totalAmount,
        date: formData.date,
        status: formData.status
      });
    } else if (mode === 'edit' && sale) {
      updateSale(sale.id, {
        customerId: formData.customerId,
        items: validItems,
        totalAmount,
        date: formData.date,
        status: formData.status
      });
    }
    
    setFormData({
      customerId: '',
      date: new Date().toISOString().split('T')[0],
      status: 'pending'
    });
    setItems([{ productId: '', quantity: 1, unitPrice: 0 }]);
    
    onClose();
  };

  const addItem = () => {
    setItems([...items, { productId: '', quantity: 1, unitPrice: 0 }]);
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: keyof SaleItem, value: string | number) => {
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], [field]: value };
    
    // If product is selected, auto-fill the unit price
    if (field === 'productId') {
      const product = products.find(p => p.id === value);
      if (product) {
        updatedItems[index].unitPrice = product.salesPrice;
      }
    }
    
    setItems(updatedItems);
  };

  const totalAmount = items.reduce((sum, item) => {
    if (item.productId && item.quantity > 0 && item.unitPrice > 0) {
      return sum + (item.quantity * item.unitPrice);
    }
    return sum;
  }, 0);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-screen overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            {mode === 'add' ? 'New Sale' : 'Edit Sale'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-2"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Customer *
              </label>
              <select
                required
                value={formData.customerId}
                onChange={(e) => setFormData({ ...formData, customerId: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">Select Customer</option>
                {customers.map(customer => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Date *
              </label>
              <input
                type="date"
                required
                value={formData.date}
                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Status
              </label>
              <select
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value as 'pending' | 'completed' | 'cancelled' })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="pending">Pending</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Note: Inventory will be automatically adjusted when status is set to "Completed"
              </p>
            </div>
          </div>

          {/* Items */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">Items</h3>
              <button
                type="button"
                onClick={addItem}
                className="inline-flex items-center px-3 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Item
              </button>
            </div>

            <div className="space-y-4">
              {items.map((item, index) => (
                <div key={index} className="p-4 border border-gray-200 rounded-lg">
                  <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
                    <div className="md:col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Product *
                      </label>
                      <select
                        required
                        value={item.productId}
                        onChange={(e) => updateItem(index, 'productId', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        <option value="">Select Product</option>
                        {products.map(product => (
                          <option key={product.id} value={product.id}>
                            {product.name} - ${product.salesPrice}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Quantity *
                      </label>
                      <input
                        type="number"
                        required
                        min="1"
                        value={item.quantity}
                        onChange={(e) => updateItem(index, 'quantity', parseInt(e.target.value) || 1)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Unit Price *
                      </label>
                      <input
                        type="number"
                        required
                        min="0"
                        step="0.01"
                        value={item.unitPrice}
                        onChange={(e) => updateItem(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>

                    <div>
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeItem(index)}
                          className="w-full px-3 py-2 text-red-600 border border-red-300 rounded-lg hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="w-4 h-4 mx-auto" />
                        </button>
                      )}
                    </div>
                  </div>

                  {item.productId && item.quantity > 0 && item.unitPrice > 0 && (
                    <div className="mt-3 text-right">
                      <span className="text-sm font-medium text-gray-600">
                        Subtotal: ${(item.quantity * item.unitPrice).toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {totalAmount > 0 && (
              <div className="mt-4 p-4 bg-blue-50 rounded-lg">
                <div className="text-right">
                  <span className="text-lg font-bold text-blue-800">
                    Total Amount: ${totalAmount.toFixed(2)}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              {mode === 'add' ? 'Create Sale' : 'Update Sale'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SaleModal;