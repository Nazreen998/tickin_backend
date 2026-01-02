import '../api/http_client.dart';
import '../config/api_config.dart';

class DriverApi {
  final HttpClient client;
  DriverApi(this.client);

  Future<List<Map<String, dynamic>>> getDriverOrders(String driverId) async {
    final res = await client.get("${ApiConfig.driver}/$driverId/orders");
    final list = (res["data"] ?? []) as List;
    return list.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }

  Future<Map<String, dynamic>> updateStatus({
    required String orderId,
    required String status, // DRIVER_STARTED, DRIVER_REACHED_DISTRIBUTOR, UNLOAD_START, UNLOAD_END, WAREHOUSE_REACHED
  }) async {
    return client.post("${ApiConfig.driver}/order/$orderId/status", body: {
      "status": status,
    });
  }
}
