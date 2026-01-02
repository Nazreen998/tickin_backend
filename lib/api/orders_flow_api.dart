import '../api/http_client.dart';
import '../config/api_config.dart';

class OrdersFlowApi {
  final HttpClient client;
  OrdersFlowApi(this.client);

  Future<Map<String, dynamic>> vehicleSelected(String orderId, String vehicleType) {
    return client.post("${ApiConfig.orders}/vehicle-selected/$orderId", body: {
      "vehicleType": vehicleType,
    });
  }

  Future<Map<String, dynamic>> loadingStart(String orderId) {
    return client.post("${ApiConfig.orders}/loading-start", body: {"orderId": orderId});
  }

  Future<Map<String, dynamic>> loadingItem({
    required String orderId,
    required String productId,
    required num qty,
  }) {
    return client.post("${ApiConfig.orders}/loading-item", body: {
      "orderId": orderId,
      "productId": productId,
      "qty": qty,
    });
  }

  Future<Map<String, dynamic>> loadingEnd(String orderId) {
    return client.post("${ApiConfig.orders}/loading-end", body: {"orderId": orderId});
  }

  Future<Map<String, dynamic>> assignDriver({
    required String orderId,
    required String driverId,
    String? vehicleNo,
  }) {
    return client.post("${ApiConfig.orders}/assign-driver", body: {
      "orderId": orderId,
      "driverId": driverId,
      if (vehicleNo != null) "vehicleNo": vehicleNo,
    });
  }
}
