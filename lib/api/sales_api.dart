import '../api/http_client.dart';
import '../config/api_config.dart';

class SalesApi {
  final HttpClient client;
  SalesApi(this.client);

  Future<Map<String, dynamic>> home() {
    return client.get("${ApiConfig.sales}/home");
  }

  Future<List<Map<String, dynamic>>> distributorDropdown() async {
    final res = await home();
    final list = (res["distributorDropdown"] ?? []) as List;
    return list.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }

  Future<List<Map<String, dynamic>>> homeProducts() async {
    final res = await home();
    final list = (res["products"] ?? []) as List;
    return list.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }
}
