import React, { useState, useEffect } from 'react';
import { useInventory, Product } from '../context/InventoryContext';
import { X } from 'lucide-react';

interface ProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: Product | null;
  mode: 'add' | 'edit' | 'view';
}

const ProductModal: React.FC<ProductModalProps> = ({ isOpen, onClose, product, mode }) => {
  const { addProduct, updateProduct } = useInventory();
  const [formData, setFormData] = useState({
    name: '',
    upc: '',
    description: '',
    picture: '',
    purchasePrice: 0,
    salesPrice: 0,
    inStock: 0
  });

  useEffect(() => {
    if (product && (mode === 'edit' || mode === 'view')) {
      setFormData({
        name: product.name,
        upc: product.upc,
        description: product.description,
        picture: product.picture,
        purchasePrice: product.purchasePrice,
        salesPrice: product.salesPrice,
        inStock: product.inStock
      });
    } else {
      setFormData({
        name: '',
        upc: '',
        description: '',
        picture: '',
        purchasePrice: 0,
        salesPrice: 0,
        inStock: 0
      });
    }
  }, [product, mode]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (mode === 'add') {
      addProduct(formData);
    } else if (mode === 'edit' && product) {
      updateProduct(product.id, formData);
    }
    
    onClose();
  };

  if (!isOpen) return null;

  const isReadOnly = mode === 'view';
  const title = mode === 'add' ? 'Add Product' : mode === 'edit' ? 'Edit Product' : 'Product Details';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-screen overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-2"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Product Name *
              </label>
              <input
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                disabled={isReadOnly}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                UPC/SKU *
              </label>
              <input
                type="text"
                required
                value={formData.upc}
                onChange={(e) => setFormData({ ...formData, upc: e.target.value })}
                disabled={isReadOnly}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Description
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                disabled={isReadOnly}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Picture URL
              </label>
              <input
                type="url"
                value={formData.picture}
                onChange={(e) => setFormData({ ...formData, picture: e.target.value })}
                disabled={isReadOnly}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
                placeholder="https://example.com/image.jpg"
              />
              {formData.picture && (
                <div className="mt-2">
                  <img
                    src={formData.picture}
                    alt="Product preview"
                    className="w-20 h-20 object-cover rounded-lg border border-gray-200"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = 'https://via.placeholder.com/80x80?text=No+Image';
                    }}
                  />
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Purchase Price *
              </label>
              <input
                type="number"
                required
                min="0"
                step="0.01"
                value={formData.purchasePrice}
                onChange={(e) => setFormData({ ...formData, purchasePrice: parseFloat(e.target.value) || 0 })}
                disabled={isReadOnly}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Sales Price *
              </label>
              <input
                type="number"
                required
                min="0"
                step="0.01"
                value={formData.salesPrice}
                onChange={(e) => setFormData({ ...formData, salesPrice: parseFloat(e.target.value) || 0 })}
                disabled={isReadOnly}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Stock Quantity *
              </label>
              <input
                type="number"
                required
                min="0"
                value={formData.inStock}
                onChange={(e) => setFormData({ ...formData, inStock: parseInt(e.target.value) || 0 })}
                disabled={isReadOnly}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
              />
            </div>

            {formData.purchasePrice > 0 && formData.inStock > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Value on Hand
                </label>
                <input
                  type="text"
                  value={`$${(formData.purchasePrice * formData.inStock).toFixed(2)}`}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 text-gray-600"
                />
              </div>
            )}
          </div>

          {!isReadOnly && (
            <div className="flex justify-end space-x-3 mt-6 pt-6 border-t border-gray-200">
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
                {mode === 'add' ? 'Add Product' : 'Save Changes'}
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
};

export default ProductModal;