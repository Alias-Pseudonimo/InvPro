import React from 'react';
import { Link } from 'react-router-dom';
import { useInventory } from '../context/InventoryContext';
import { Package, Users, Truck, DollarSign, TrendingUp, AlertTriangle, Calculator, PieChart, BarChart3 } from 'lucide-react';

const Dashboard: React.FC = () => {
  const { products, customers, suppliers, sales, purchases } = useInventory();

  const totalProducts = products.length;
  const totalCustomers = customers.length;
  const totalSuppliers = suppliers.length;
  const totalInventoryValue = products.reduce((sum, product) => sum + product.valueOnHand, 0);
  const lowStockProducts = products.filter(product => product.inStock < 10);
  const recentSales = sales.slice(-5).reverse();

  // Financial calculations
  const completedSales = sales.filter(sale => sale.status === 'completed');
  const receivedPurchases = purchases.filter(purchase => purchase.status === 'received');
  
  const totalRevenue = completedSales.reduce((sum, sale) => sum + sale.totalAmount, 0);
  const totalCosts = receivedPurchases.reduce((sum, purchase) => sum + purchase.totalAmount, 0);
  const grossProfit = totalRevenue - totalCosts;
  const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  
  // Monthly calculations
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();
  
  const monthlySales = completedSales.filter(sale => {
    const saleDate = new Date(sale.date);
    return saleDate.getMonth() === currentMonth && saleDate.getFullYear() === currentYear;
  });
  
  const monthlyPurchases = receivedPurchases.filter(purchase => {
    const purchaseDate = new Date(purchase.date);
    return purchaseDate.getMonth() === currentMonth && purchaseDate.getFullYear() === currentYear;
  });
  
  const monthlyRevenue = monthlySales.reduce((sum, sale) => sum + sale.totalAmount, 0);
  const monthlyCosts = monthlyPurchases.reduce((sum, purchase) => sum + purchase.totalAmount, 0);
  const monthlyProfit = monthlyRevenue - monthlyCosts;

  const stats = [
    {
      name: 'Total Products',
      value: totalProducts.toString(),
      icon: Package,
      color: 'bg-blue-500',
      change: '+4.75%',
      changeType: 'positive'
    },
    {
      name: 'Total Customers',
      value: totalCustomers.toString(),
      icon: Users,
      color: 'bg-green-500',
      change: '+2.02%',
      changeType: 'positive'
    },
    {
      name: 'Total Suppliers',
      value: totalSuppliers.toString(),
      icon: Truck,
      color: 'bg-purple-500',
      change: '+1.01%',
      changeType: 'positive'
    },
    {
      name: 'Inventory Value',
      value: `$${totalInventoryValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      icon: DollarSign,
      color: 'bg-yellow-500',
      change: '+12.5%',
      changeType: 'positive'
    }
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <div className="text-sm text-gray-500">
          {new Date().toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.name} className="bg-white overflow-hidden shadow-sm rounded-lg border border-gray-200">
            <div className="p-6">
              <div className="flex items-center">
                <div className={`flex-shrink-0 p-3 rounded-lg ${stat.color}`}>
                  <stat.icon className="w-6 h-6 text-white" />
                </div>
                <div className="ml-4 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">
                      {stat.name}
                    </dt>
                    <dd className="text-2xl font-bold text-gray-900">
                      {stat.value}
                    </dd>
                  </dl>
                </div>
              </div>
              <div className="mt-4 flex items-center">
                <TrendingUp className="w-4 h-4 text-green-500" />
                <span className="ml-2 text-sm text-green-600 font-medium">
                  {stat.change}
                </span>
                <span className="ml-2 text-sm text-gray-500">vs last month</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Financial Summary */}
      <div className="bg-white shadow-sm rounded-lg border border-gray-200">
        <div className="p-6">
          <div className="flex items-center mb-6">
            <Calculator className="w-6 h-6 text-indigo-600" />
            <h3 className="ml-2 text-lg font-semibold text-gray-900">Profit & Loss Summary</h3>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Total Revenue */}
            <div className="bg-green-50 p-4 rounded-lg">
              <div className="flex items-center">
                <div className="p-2 bg-green-100 rounded-lg">
                  <TrendingUp className="w-5 h-5 text-green-600" />
                </div>
                <div className="ml-3">
                  <p className="text-sm font-medium text-green-600">Total Revenue</p>
                  <p className="text-xl font-bold text-green-800">
                    ${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
              </div>
            </div>

            {/* Total Costs */}
            <div className="bg-red-50 p-4 rounded-lg">
              <div className="flex items-center">
                <div className="p-2 bg-red-100 rounded-lg">
                  <BarChart3 className="w-5 h-5 text-red-600" />
                </div>
                <div className="ml-3">
                  <p className="text-sm font-medium text-red-600">Total Costs</p>
                  <p className="text-xl font-bold text-red-800">
                    ${totalCosts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
              </div>
            </div>

            {/* Gross Profit */}
            <div className={`${grossProfit >= 0 ? 'bg-blue-50' : 'bg-orange-50'} p-4 rounded-lg`}>
              <div className="flex items-center">
                <div className={`p-2 ${grossProfit >= 0 ? 'bg-blue-100' : 'bg-orange-100'} rounded-lg`}>
                  <PieChart className={`w-5 h-5 ${grossProfit >= 0 ? 'text-blue-600' : 'text-orange-600'}`} />
                </div>
                <div className="ml-3">
                  <p className={`text-sm font-medium ${grossProfit >= 0 ? 'text-blue-600' : 'text-orange-600'}`}>
                    Gross Profit
                  </p>
                  <p className={`text-xl font-bold ${grossProfit >= 0 ? 'text-blue-800' : 'text-orange-800'}`}>
                    ${grossProfit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
              </div>
            </div>

            {/* Profit Margin */}
            <div className={`${profitMargin >= 0 ? 'bg-purple-50' : 'bg-gray-50'} p-4 rounded-lg`}>
              <div className="flex items-center">
                <div className={`p-2 ${profitMargin >= 0 ? 'bg-purple-100' : 'bg-gray-100'} rounded-lg`}>
                  <span className={`text-sm font-bold ${profitMargin >= 0 ? 'text-purple-600' : 'text-gray-600'}`}>
                    %
                  </span>
                </div>
                <div className="ml-3">
                  <p className={`text-sm font-medium ${profitMargin >= 0 ? 'text-purple-600' : 'text-gray-600'}`}>
                    Profit Margin
                  </p>
                  <p className={`text-xl font-bold ${profitMargin >= 0 ? 'text-purple-800' : 'text-gray-800'}`}>
                    {profitMargin.toFixed(1)}%
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Monthly Performance */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <h4 className="text-md font-medium text-gray-900 mb-4">This Month's Performance</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-600">Monthly Revenue</p>
                <p className="text-lg font-bold text-gray-900">
                  ${monthlyRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-600">Monthly Costs</p>
                <p className="text-lg font-bold text-gray-900">
                  ${monthlyCosts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              <div className="text-center p-3 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-600">Monthly Profit</p>
                <p className={`text-lg font-bold ${monthlyProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  ${monthlyProfit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Low Stock Alert */}
        <div className="bg-white shadow-sm rounded-lg border border-gray-200">
          <div className="p-6">
            <div className="flex items-center">
              <AlertTriangle className="w-6 h-6 text-orange-500" />
              <h3 className="ml-2 text-lg font-semibold text-gray-900">Low Stock Alert</h3>
            </div>
            <div className="mt-4">
              {lowStockProducts.length === 0 ? (
                <p className="text-sm text-gray-500">All products are well stocked!</p>
              ) : (
                <div className="space-y-3">
                  {lowStockProducts.map(product => (
                    <div key={product.id} className="flex items-center justify-between p-3 bg-orange-50 rounded-lg">
                      <div className="flex items-center">
                        <img 
                          src={product.picture} 
                          alt={product.name}
                          className="w-10 h-10 rounded-lg object-cover"
                        />
                        <div className="ml-3">
                          <p className="text-sm font-medium text-gray-900">{product.name}</p>
                          <p className="text-xs text-gray-500">SKU: {product.upc}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-orange-600">{product.inStock} left</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="bg-white shadow-sm rounded-lg border border-gray-200">
          <div className="p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Recent Sales</h3>
              <TrendingUp className="w-5 h-5 text-green-500" />
            </div>
            <div className="mt-4">
              {recentSales.length === 0 ? (
                <p className="text-sm text-gray-500">No recent sales to display.</p>
              ) : (
                <div className="space-y-3">
                  {recentSales.map(sale => {
                    const customer = customers.find(c => c.id === sale.customerId);
                    return (
                      <div key={sale.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {customer?.name || 'Unknown Customer'}
                          </p>
                          <p className="text-xs text-gray-500">
                            {new Date(sale.date).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-bold text-green-600">
                            ${sale.totalAmount.toFixed(2)}
                          </p>
                          <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                            sale.status === 'completed' 
                              ? 'bg-green-100 text-green-800'
                              : sale.status === 'pending'
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-red-100 text-red-800'
                          }`}>
                            {sale.status}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white shadow-sm rounded-lg border border-gray-200">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Link 
              to="/products" 
              className="flex flex-col items-center p-4 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
            >
              <Package className="w-8 h-8 text-blue-600 mb-2" />
              <span className="text-sm font-medium text-blue-700">Add Product</span>
            </Link>
            <Link 
              to="/customers" 
              className="flex flex-col items-center p-4 bg-green-50 rounded-lg hover:bg-green-100 transition-colors"
            >
              <Users className="w-8 h-8 text-green-600 mb-2" />
              <span className="text-sm font-medium text-green-700">Add Customer</span>
            </Link>
            <Link 
              to="/suppliers" 
              className="flex flex-col items-center p-4 bg-purple-50 rounded-lg hover:bg-purple-100 transition-colors"
            >
              <Truck className="w-8 h-8 text-purple-600 mb-2" />
              <span className="text-sm font-medium text-purple-700">Add Supplier</span>
            </Link>
            <Link 
              to="/sales" 
              className="flex flex-col items-center p-4 bg-yellow-50 rounded-lg hover:bg-yellow-100 transition-colors"
            >
              <TrendingUp className="w-8 h-8 text-yellow-600 mb-2" />
              <span className="text-sm font-medium text-yellow-700">New Sale</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;