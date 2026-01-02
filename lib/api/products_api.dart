import '../api/http_client.dart';
import '../config/api_config.dart';

class ProductsApi {
  final HttpClient client;
  ProductsApi(this.client);

  Future<List<Map<String, dynamic>>> listProducts() async {
    final res = await client.get(ApiConfig.products);
    final list = (res["products"] ?? []) as List;
    return list.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }

  // MASTER மட்டும்
  Future<Map<String, dynamic>> importExcel() async {
    return client.post("${ApiConfig.products}/import-excel");
  }
}
  